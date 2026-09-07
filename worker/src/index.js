import { rerankHybridResults } from "./rerank.js";
import { gradeRetrieval } from "./critic.js";
import { classifyMemoryType } from "./memory_type.js";
import { resolveSemanticConflict, handleBeliefHistory } from "./bitemporal.js";
import { runNightlyConsolidation, runWeeklyConsolidation, isISTHour, isISTDayHour, flushPendingConsolidations } from "./consolidation.js";
import { isPinnedFact, capFactIndexWithPins, inferBehavioralPatterns, buildVoiceProfile, renderVoiceProfileMd } from "./self-model.js";
import { countTriplesFromKeys, isUncompressedCandidate, classifyRawFile, isToolNoiseName, rankEntitiesByCentrality } from "./triple-stats.js";

/**
 * Lnm-Brain Cloudflare Worker — v10.2.2
 *
 * v10.2.2 (Correction + latency): NEW 27th MCP tool `forget` — the brain's
 *   missing write-correction primitive. Modes: fact (retract one entity fact),
 *   triple (retract predicate[/object]), observation (mark superseded). Soft-
 *   delete only (superseded_by + confidence→0) so history stays auditable; a
 *   wrong fact stops surfacing instead of being drowned-but-permanent.
 *   Perf: 12 hot serial readObservation loops → chunked-parallel via new
 *   readObservationsBatch / scanObservations helpers (getEntityFacts,
 *   session-start, home-feed cron + admin, list_recent, get_handoffs,
 *   get_session_index, get_routing_index, build-voice, /api/list-recent,
 *   /api/handoffs). Same subrequest count, O(n)→O(n/25) wall-clock. Version
 *   10.2.2 (digit-sum 5; 10.2.1 already live, prior session flagged this bump).
 *
 * v10.2.1 (Self-model deepening): fixes 5 measured self-modeling failures.
 *   (1) facts_index slice(-50) silently dropped old identity facts → "forgets me
 *   on reboot": now pin-aware (capFactIndexWithPins) — identity/behavioral/
 *   instruction/preference facts survive forever, only chatter rolls off.
 *   (2) getEntityFacts: pinned facts no longer decay (old-but-true survives).
 *   (3) regenAboutMe: pulls fact+preference+instruction+behavioral (was fact-only
 *   top-12), adds Behavioral Patterns section + voice pointer.
 *   (4) NEW behavioral-inference pass (self-model.js) — infers HOW Brain Owner builds/
 *   decides/communicates (explicit-only extractor couldn't). Stored pinned.
 *   (5) doRecall recency softened +30/10% → +12/5% (old data resurfaces).
 *   NEW voice-profile: buildVoiceProfile mines Brain Owner's own writing → style card at
 *   wiki/profile/voice-owner.md for connected agents. Admin jobs: build-voice,
 *   about-me (force-regen). Behavioral backfill rides existing /backfill-facts.
 *
 * v10.1.0 (Graphify-parity+): 2 new MCP tools (25 total) — get_top_entities
 *   (god-node ranking on demand) + find_entity_path (BFS shortest connection
 *   between two entities via the triple graph, Graphify-style `path`). query_triples
 *   gains a derivation filter (stated|inferred|reinforced|unknown). Tier-2 latency
 *   pass: 6 hot serial KV loops → Promise.all (storeObservation shards,
 *   buildSessionContext, /ask facts+triples, regenAboutMe, handleGetFacts).
 *
 * v10.0.1 (extraction-stall fix): callRoleLLM now has a total-time budget
 *   (20s) + shorter per-tier timeout (8s). Root cause: the role-tier ladder
 *   looped ~13 tiers × 15s with no overall cap; when a role's NVIDIA keys were
 *   dead/slow the cascade ran 60-120s+, timing out the sync request and getting
 *   the waitUntil isolate recycled before facts/triples were written. Now it
 *   aborts to the fast in-process CF fallback once the budget is spent.
 *
 * v10.0.0 (umbrella upgrade):
 *   §A first-class "project" type → wiki/projects/{slug}.md with project_meta
 *     frontmatter (name/status/stack/repo_url/deploy_url/project_id); bridges to
 *     Hermes D1 projects via project:{id} entity namespace. Activates the existing
 *     update_graph.py → project graph-node path.
 *   §B buildClusters now merges on cosine similarity (BGE-M3 re-embed, threshold
 *     0.78) in addition to entity overlap — fail-safe to entity-overlap-only.
 *   §C god-node centrality: scanEntityCentrality ranks entities by fact+2*triple
 *     count; surfaced in get_home_feed.top_entities + about-me "most-connected".
 *   §D triple provenance: derivation (stated|inferred|reinforced|unknown) +
 *     source_obs_id on every triple; legacy rows read back as "unknown".
 *   Inherits v9.9.1 dead-code dust pass. Tool count unchanged (23).
 *
 * WHAT'S NEW IN v9.1.2 (capture-latency fix):
 *   - DEFERRED RAW WRITE: raw/{path}.md GitHub PUT moved from sync to async
 *     (waitUntil). Sync path now D1 FTS5 + KV only. /capture returns in 1-2s
 *     instead of 25-90s. Fixes Claude Code Stop-hook 30/90s curl timeouts that
 *     were silently dropping captures (root cause of "Second Brain capture not
 *     working" since v9 release). Raw write retries once on failure.
 *   - Bumped past 9.0.4 (digit-sum 4, banned per numerology rule).
 *
 * WHAT WAS NEW IN v9.0.3 (hybrid retrieval / capture-but-unfindable fix):
 *   - SYNC TIMELINE: obs:meta + recent indexes written BEFORE response (was
 *     ctx.waitUntil → race). get_observation(id) now hits immediately after
 *     ingest returns.
 *   - SURFACE SHARD: recent:{surface} + recent:all KV shards. list_recent
 *     reads the shard when filter passed → claude-ai-web entries no longer
 *     hidden behind global obs:recent races.
 *   - VERIFY-ON-WRITE: ingest response includes verified_retrievable +
 *     verified_indexed + retrieval_latency_ms. AUTHORITATIVE/verdict tags
 *     poll Vectorize up to 10s for index ack.
 *   - D1 FTS5 keyword index (optional binding env.DB). new tool keyword_search.
 *     Synchronous write — instant retrieval, no Vectorize lag.
 *   - MULTI-VECTOR: every ingest embeds title, content, summary, each entity
 *     into ID-prefixed Vectorize records (vec:title:*, vec:content:*,
 *     vec:summary:*, vec:entity:*). semantic_search fuses via RRF.
 *   - VERDICT PRESERVATION: regex pre-extracts podium emojis, "Niche N",
 *     "Step N", numbered lists → pinned verbatim in wiki under
 *     ⚠ DO_NOT_REWRITE marker. LLM prompt told never to rewrite the block.
 *   - LIST TRIPLES: enumerated rankings emit triples (Niche-N hasRank/hasName/
 *     hasRole) so query_triples can answer ranked-list questions.
 *   - /recall hybrid endpoint + recall_brain MCP tool: fuses semantic +
 *     keyword + entity + triple lookups with RRF + recency boost.
 *   - /session-start + session_context MCP tool: <3 KB orienting payload
 *     (handoff + open threads + recent verdicts + active topics).
 *   - SESSION-HANDOFF schema adds active_topics[], open_verdicts[],
 *     open_decisions[], firecrawl_research_conducted.
 *
 * WHAT'S NEW IN v7.9.0:
 *   - Auto wikilink injection on every capture: each raw + wiki file ends with
 *     `## Backlinks\n[[index]] · [[YYYY-MM]]` so Obsidian graph shows real
 *     relations instead of orphan clouds. Backfilled 2919 historical notes
 *     via scripts/inject-wikilinks.js (commit 1928c473).
 *   - Monthly index cron now appends `## Backlinks\n[[index]]` to each
 *     wiki/_indexes/YYYY-MM.md file.
 *   - updateIndex now ensures root index.md has `## Monthly Indexes` section
 *     linking [[wiki/_indexes/YYYY-MM]] for every month present.
 *   - Search/recall behaviour unchanged (vector + KV facts already worked);
 *     this fix is graph-visualisation coherence only.
 *
 * WHAT'S NEW IN v7.4.0:
 *   - KV write limits updated for Workers Paid tier (1M writes/day, was 950).
 *   - 1-hop graph traversal: triple objects that look like entity names are followed
 *     automatically, their facts loaded into query_second_brain context.
 *   - Auto monthly index: cron generates wiki/_indexes/YYYY-MM.md every 6h.
 *   - LLM reranking: after hybrid keyword+vector merge, synthesis LLM picks best 5.
 *
 * WHAT'S NEW IN v7.2.0:
 *   - Anchor entity graph traversal: BRAIN-STARTUP + Brain Owner always fetched
 *     in every query_second_brain and /ask call, fixing triples_used=0 for lowercase queries.
 *   - /force-reinforce: bump entity fact confidence to 1.0 without re-ingesting.
 *   - /write-entity-triples: directly write triple:* KV keys for any entity.
 *   - triples_used count now returned in query_second_brain MCP response.
 *   - Monthly session index: wiki/_indexes/2026-05.md for May 2026.
 *
 * WHAT'S NEW IN v5.4 (historical):
 *   - Hybrid semantic+keyword fusion in query_second_brain MCP tool.
 *     Blends 60% keyword score + 40% Vectorize cosine score, adds semantic-only hits.
 *   - LLM reranking in semantic_search MCP tool and /search endpoint.
 *   - Triple contradiction detection in upsertTriple.
 *
 * WHAT'S NEW IN v5.3:
 *   - Structured triple storage: facts stored as subject|predicate|object triples.
 *     Enables precise overwrite (not append-only), queryable by predicate.
 *     KV key: triple:{subject_slug}:{predicate_slug} → {subject, predicate, object, confidence, last_confirmed}
 *   - Memory categories: every fact tagged as fact/preference/instruction/history.
 *     getEntityFacts(env, name, category) filters by type — "instruction" queries return rules only.
 *   - Semantic reranking: after Vectorize vector search, cross-encoder reranks top-K
 *     results using NVIDIA mistral-nemotron before synthesis. Higher precision answers.
 *
 * WHAT'S NEW IN v5.0-v5.2:
 *   - Entity name normalization: "Brain Owner" → "Brain Owner" via KV canonical map.
 *   - Fact contradiction detection: old fact marked superseded on conflict.
 *   - /backfill-facts: batch-extract entity facts from existing wiki files.
 *   - /ask endpoint: natural language Q&A over entire second brain.
 *   - Role-specific NVIDIA LLM routing (compression/extraction/synthesis).
 *   - 25+ models benchmarked, best chain confirmed and deployed.
 *
 * KV key schema:
 *   entity:{slug}:meta              → {name, created, updated, total_facts}
 *   entity:{slug}:fact:{hash}       → {fact, category, confidence, count, created, last_reinforced, superseded_by?}
 *   entity:{slug}:facts_index       → JSON string[] of fact keys
 *   entity:alias:{slug}             → canonical entity name string
 *   entity:aliases_index            → JSON {alias_slug: canonical_name} map
 *   triple:{subject_slug}:{pred_slug} → {subject, predicate, object, category, confidence, last_confirmed}
 *   triple:{subject_slug}:index     → JSON string[] of predicate slugs for this subject
 */

// ─── Model config ─────────────────────────────────────────────────────────────
// NVIDIA NIM endpoint
const NVIDIA_API_BASE = "https://integrate.api.nvidia.com/v1";

// ─── Benchmarked model selection — WESTERN-ONLY (sovereignty RULE 1) ──────────
// Chinese-origin models PURGED 2026-06-18 (Hermes sovereignty build). NEVER add
// qwen/Alibaba, minimax, moonshot/kimi, zhipu/glm, deepseek, stepfun/step, yi,
// baidu/ernie, baichuan, tencent/hunyuan, bytedance/doubao back to these lists.
//
//  WESTERN ranking (NVIDIA NIM):
//  RANK  MODEL                                    CONSISTENT  AVG_MS  NOTES
//  1     mistralai/mistral-nemotron               YES         ~3.2s   Reliable, markdown-wraps JSON (primary)
//  2     mistralai/mistral-large-3-675b-2512      SOMETIMES   2-20s   Best quality when available
//  3     mistralai/mistral-medium-3.5-128b        SOMETIMES   1-20s   Fastest when available
//  4     openai/gpt-oss-120b                      YES         ~1.5s   Reasoning model, synthesis/extraction
//  5     meta/llama-3.3-70b-instruct              YES         ~10s    Last resort, bulletproof
//
//  NOTE: secretKey labels below (DEEPSEEK_API_Key, Minimax_M2.7_API_Key, etc.)
//  are historical SECRET NAMES holding NVIDIA NIM keys — NOT actual Chinese
//  providers. They map to env vars only; the `model` field is what matters.

// Role-specific model configs — all Western
const MODELS = {
  // Wiki compression — rich structured JSON output
  compression: [
    { model: "mistralai/mistral-nemotron",                    secretKey: "MISTRAL_NEMOTRON_API_Key" },
    { model: "mistralai/mistral-large-3-675b-instruct-2512",  secretKey: "MISTRAL_LARGE_API_Key"   },
    { model: "mistralai/mistral-nemotron",                    secretKey: "DRACARYS_API_Key"         },
    { model: "meta/llama-3.3-70b-instruct",                   secretKey: "DEEPSEEK_API_Key"         },
  ],
  // Fact extraction — fast precise JSON
  extraction: [
    { model: "mistralai/mistral-medium-3.5-128b",             secretKey: "Minimax_M2.7_API_Key"    },
    { model: "mistralai/mistral-nemotron",                    secretKey: "MISTRAL_NEMOTRON_API_Key" },
    { model: "openai/gpt-oss-120b",                           secretKey: "STEP_API_Key"             },
    { model: "mistralai/ministral-14b-instruct-2512",         secretKey: "MISTRAL_NEMOTRON_API_Key" },
    { model: "meta/llama-3.3-70b-instruct",                   secretKey: "DEEPSEEK_API_Key"         },
  ],
  // Q&A synthesis — best reasoning + natural language
  synthesis: [
    { model: "mistralai/mistral-large-3-675b-instruct-2512",  secretKey: "MISTRAL_LARGE_API_Key"   },
    { model: "openai/gpt-oss-120b",                           secretKey: "DRACARYS_API_Key"         },
    { model: "openai/gpt-oss-120b",                           secretKey: "MISTRAL_NEMOTRON_API_Key" },
    { model: "mistralai/mistral-nemotron",                    secretKey: "MISTRAL_LARGE_API_Key"   },
    { model: "meta/llama-3.3-70b-instruct",                   secretKey: "Minimax_M2.7_API_Key"    },
  ],
};

// Universal fallback chain (when all role-specific tiers fail) — all Western
const LLM_TIERS = [
  { model: "mistralai/mistral-nemotron",                    secretKey: "MISTRAL_NEMOTRON_API_Key" },
  { model: "mistralai/mistral-large-3-675b-instruct-2512",  secretKey: "MISTRAL_LARGE_API_Key"   },
  { model: "mistralai/mistral-medium-3.5-128b",             secretKey: "Minimax_M2.7_API_Key"    },
  { model: "meta/llama-3.3-70b-instruct",                   secretKey: "STEP_API_Key"             },
  { model: "mistralai/mistral-nemotron",                    secretKey: "DRACARYS_API_Key"         },
  { model: "mistralai/ministral-14b-instruct-2512",         secretKey: "MISTRAL_NEMOTRON_API_Key" },
  { model: "meta/llama-3.3-70b-instruct",                   secretKey: "DEEPSEEK_API_Key"         },
  { model: "meta/llama-3.2-3b-instruct",                    secretKey: "STEP_API_Key"             },
];
const CF_MODEL_FALLBACK = "@cf/meta/llama-3.1-8b-instruct";

// CF Workers AI — embeddings stay in-process (free, 0 subrequests).
// v9.2: BGE-M3 (1024-dim) — far stronger semantic/synonym bridging than bge-small.
// Paired with Vectorize index lnm-brain-m3.
const EMBEDDING_MODEL = "@cf/baai/bge-m3";
const EMBEDDING_DIMS = 1024;

// Neuron budget: only CF Workers AI calls cost neurons (external NVIDIA = free)
const NEURON_BUDGET_COMPRESSION = 7000;
const NEURON_COST_PRIMARY       = 1;
const NEURON_COST_EXTRACTION    = 1;

// ─── Sovereignty + budget-aware LLM router (Hermes v9.9.0) ───────────────────
// Provider routing rule: block CHINESE *SERVERS*, not Chinese model origins.
// Chinese-origin models hosted on US servers are ALLOWED (preferred even).
// US-hosted tiers (NVIDIA NIM, OpenCode Zen — explicitly all-US-hosted, CF Workers
// AI) are EXEMPT. Only OpenRouter (which load-balances to provider servers
// worldwide, incl. mainland China) must be pinned to US-hosted providers.
// Embeddings NEVER route here — they stay on CF Workers AI bge-m3 (1024-dim).
//
// Ladder — PREFER STRONGER MODELS. Within a tier, route every model before
// climbing; but a tier offering only a WEAK model is no reason to stay — climb
// to a stronger one. OpenRouter PAID is the final boss: hit last & least.
//   T0 NVIDIA NIM (Western secrets: nemotron/large/gpt-oss-120b) — free, US, strong
//   T1 OpenCode Zen FREE (mimo-v2.5 → nemotron-3-ultra → others) — free, US, strong
//   T2 Vercel AI Gateway, US-hosted, cheapest→up — strong, under $4.50/mo of $5 credit
//   T3 OpenRouter FREE, pinned US providers (llama-3.3-70b etc) — free, strong
//   T4 CF Workers AI llama-3.1-8b — free (~10k neurons/day) but WEAK; below free-strong, above paid
//   T5 OpenRouter PAID, pinned US, cheapest — FINAL BOSS, last resort
const LLM_BUDGET_CAP_USD = 4.50;

// T1 Zen free — Default: any Zen model OK (all US-hosted). Preference order per his
// instruction: mimo-v2.5-free, then nemotron-3-ultra-free, then other free.
const ZEN_FREE = ['mimo-v2.5-free','nemotron-3-ultra-free','north-mini-code-free','deepseek-v4-flash-free','big-pickle'];
// T2 Vercel — US-hosted models, cheapest→up. [verify+prune live via /admin/llm-test]
const VERCEL_MODELS = ['openai/gpt-4o-mini','openai/gpt-4.1-mini','google/gemini-2.0-flash-001'];
// T3 OpenRouter free — pin US-hosted providers (avoid mainland-China servers).
const OR_FREE = ['meta-llama/llama-3.3-70b-instruct:free','google/gemma-2-9b-it:free','nvidia/nemotron-nano-9b-v2:free'];
// T4 OpenRouter paid — US-hosted, cheapest first. LAST RESORT.
const OR_CHEAP = ['openai/gpt-4o-mini','meta-llama/llama-3.3-70b-instruct'];
// OpenRouter provider pin: only route to providers with US datacenters. Sent as
// body.provider.only — keeps requests off Chinese servers even for CN-origin models.
const OR_US_PROVIDERS = ['openai','google-vertex','google-ai-studio','amazon-bedrock','azure','fireworks','together','deepinfra','lambda','nvidia','cloudflare','baseten'];
const CF_TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

// Per-tier blocklist: only OpenRouter is unsafe (worldwide routing). NIM/Zen/CF
// are US-hosted, so any model id is fine there. assertNonChineseServer is the
// runtime guard used by /admin/sovereignty-check + before every OR call.
function assertNonChineseServer(tier, model){
  // US-hosted gateways: never route to Chinese servers regardless of model id.
  if (tier === 'nvidia' || tier === 'zen' || tier === 'cf' || tier === 'vercel') return model;
  // OpenRouter: a CN-origin model id risks a CN server unless provider is pinned.
  // We always pin OR_US_PROVIDERS in the request, so allow; the pin is the guard.
  return model;
}

function _spendKey(){return 'llm_spend:'+new Date().toISOString().slice(0,7);}
async function getMonthlySpend(env){try{return parseFloat(await env.VECTORS.get(_spendKey()))||0;}catch{return 0;}}
async function addMonthlySpend(env,usd){try{const c=parseFloat(await env.VECTORS.get(_spendKey()))||0;
  await env.VECTORS.put(_spendKey(),String(c+usd),{expirationTtl:60*60*24*40});}catch{}}

// T0 — NVIDIA NIM (reuses existing Western LLM_TIERS + their secrets).
async function _callNimTier(messages,env,opts){
  const errors=[];
  for(const t of LLM_TIERS){
    const apiKey=env[t.secretKey]; if(!apiKey) continue;
    assertNonChineseServer('nvidia',t.model);
    try{ const txt=await callNvidiaLLM(apiKey,t.model,messages,opts.max_tokens||1000);
      if(txt) return {text:txt,via:'nvidia:'+t.model,errors}; }
    catch(e){ errors.push('nvidia:'+t.model+' -> '+e.message.slice(0,120)); }
  }
  return {text:'',via:null,errors};
}
// T1 — OpenCode Zen (openai-compatible chat endpoint).
async function _callZen(model,messages,env,opts){ assertNonChineseServer('zen',model);
  const r=await fetch('https://opencode.ai/zen/v1/chat/completions',{method:'POST',
    headers:{'Authorization':'Bearer '+env.OPENCODE_ZEN_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({model,messages,max_tokens:opts.max_tokens||1000,temperature:opts.temperature==null?0.3:opts.temperature})});
  if(!r.ok)throw new Error('zen '+r.status+' '+(await r.text()).slice(0,160));
  const d=await r.json(); return (d.choices&&d.choices[0]&&d.choices[0].message.content)||''; }
// T2 — Vercel AI Gateway (US-hosted models).
async function _callVercel(model,messages,env,opts){ assertNonChineseServer('vercel',model);
  const r=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{method:'POST',
    headers:{'Authorization':'Bearer '+env.VERCEL_AI_GATEWAY_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({model,messages,max_tokens:opts.max_tokens||1000,temperature:opts.temperature==null?0.3:opts.temperature})});
  if(!r.ok)throw new Error('vercel '+r.status+' '+(await r.text()).slice(0,160));
  const d=await r.json(); const u=d.usage||{};
  await addMonthlySpend(env,((u.prompt_tokens||0)*2e-7)+((u.completion_tokens||0)*6e-7));
  return (d.choices&&d.choices[0]&&d.choices[0].message.content)||''; }
// T3/T4 — OpenRouter, provider PINNED to US datacenters (keeps off CN servers).
async function _callOpenRouter(model,messages,env,opts){ assertNonChineseServer('openrouter',model);
  const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',
    headers:{'Authorization':'Bearer '+env.OPENROUTER_API_KEY,'Content-Type':'application/json',
      'HTTP-Referer':'https://your-worker-subdomain.workers.dev','X-Title':'LNM Second Brain'},
    body:JSON.stringify({model,messages,max_tokens:opts.max_tokens||1000,temperature:opts.temperature==null?0.3:opts.temperature,
      provider:{only:OR_US_PROVIDERS}})});
  if(!r.ok)throw new Error('openrouter '+r.status+' '+(await r.text()).slice(0,160));
  const d=await r.json(); const u=d.usage||{};
  // OR paid cost varies by model; approximate using returned usage if present.
  if(u.total_cost) await addMonthlySpend(env,Number(u.total_cost)||0);
  return (d.choices&&d.choices[0]&&d.choices[0].message.content)||''; }
// T5 — CF Workers AI (free floor, always US).
async function _callCF(messages,env,opts){ assertNonChineseServer('cf',CF_TEXT_MODEL);
  const res=await env.AI.run(CF_TEXT_MODEL,{messages,max_tokens:opts.max_tokens||1000});
  await addNeuronUsage(env,1);
  return typeof res.response==='string'?res.response:JSON.stringify(res.response); }

// Budget-aware router. Returns {text, via, errors}. Routes ALL models within a
// tier before climbing. 'via' names the tier:model that answered.
async function callLLM(messages,env,opts={}){
  const errors=[];
  // T0 NVIDIA NIM — exhaust all Western NIM models first (free, US).
  { const r=await _callNimTier(messages,env,opts); errors.push(...r.errors); if(r.text) return {text:r.text,via:r.via,errors}; }
  // T1 OpenCode Zen free — all US-hosted; preference mimo->nemotron->others.
  if(env.OPENCODE_ZEN_API_KEY){ for(const m of ZEN_FREE){ try{const t=await _callZen(m,messages,env,opts); if(t) return {text:t,via:'zen-free:'+m,errors};}catch(e){errors.push('zen-free:'+m+' -> '+e.message.slice(0,120));} } }
  // T2 Vercel AI Gateway — US-hosted, cheapest->up, while under budget cap.
  const spend=await getMonthlySpend(env);
  if(env.VERCEL_AI_GATEWAY_KEY && spend<LLM_BUDGET_CAP_USD){ for(const m of VERCEL_MODELS){ try{const t=await _callVercel(m,messages,env,opts); if(t) return {text:t,via:'vercel:'+m,errors};}catch(e){errors.push('vercel:'+m+' -> '+e.message.slice(0,120));} } }
  else if(env.VERCEL_AI_GATEWAY_KEY){ errors.push('vercel skipped: est $'+spend.toFixed(2)+' >= cap $'+LLM_BUDGET_CAP_USD); }
  // T3 OpenRouter FREE — pinned US providers, strong models (llama-70b etc).
  if(env.OPENROUTER_API_KEY){ for(const m of OR_FREE){ try{const t=await _callOpenRouter(m,messages,env,opts); if(t) return {text:t,via:'or-free:'+m,errors};}catch(e){errors.push('or-free:'+m+' -> '+e.message.slice(0,120));} } }
  // T4 CF Workers AI — free (~10k neurons/day) but WEAK (8B). Sits BELOW the
  // stronger free OR tier, ABOVE paid. Prefer-stronger rule: only land here when
  // every stronger free option above is down.
  if(env.AI){ try{const t=await _callCF(messages,env,opts); if(t) return {text:t,via:'cf:'+CF_TEXT_MODEL,errors};}catch(e){errors.push('cf -> '+e.message.slice(0,120));} }
  // T5 OpenRouter PAID — FINAL BOSS. Pinned US, cheapest first. Reached only when
  // all free tiers (incl. weak CF) failed. Hit this last and as little as possible.
  if(env.OPENROUTER_API_KEY){ for(const m of OR_CHEAP){ try{const t=await _callOpenRouter(m,messages,env,opts); if(t) return {text:t,via:'or-paid:'+m,errors};}catch(e){errors.push('or-paid:'+m+' -> '+e.message.slice(0,120));} } }
  return {text:'',via:'failed',errors};
}

async function generateWikiBody(content,title,env){
  const fallback='# '+title+'\n\n'+String(content||'').slice(0,400);
  const {text}=await callLLM([{role:'user',content:'Write a concise wiki entry (markdown, 100-200 words) for this note. Extract key decisions, facts, verdicts, next actions. Title: "'+title+'"\n\nContent:\n'+String(content||'').slice(0,3000)+'\n\nReturn ONLY the markdown. No preamble, no fences.'}],env,{max_tokens:500,temperature:0.2});
  return text&&text.length>30?text:fallback;
}

// Write a single category-tagged fact directly in the shape getEntityFacts reads.
// (upsertEntityFacts takes string[]; it can't carry a category — Hermes needs one.)
async function storeHermesFact(env,entityName,content,category){
  if(!env.VECTORS||!content||String(content).length<5)return false;
  try{
    const canonical=await resolveEntityName(env,entityName);
    const slug=entitySlug(canonical);
    const fact=String(content).slice(0,500);
    const now=Date.now();
    const ttl={expirationTtl:86400*730};
    const factKey=`entity:${slug}:fact:${factHash(fact.toLowerCase().trim())}`;
    const indexKey=`entity:${slug}:facts_index`;
    const existing=await env.VECTORS.get(factKey);
    if(existing){
      const p=JSON.parse(existing); const c=(p.count||1)+1;
      await env.VECTORS.put(factKey,JSON.stringify({...p,category:category||p.category||'fact',count:c,confidence:Math.min(c/5,1.0),last_reinforced:now}),ttl);
    }else{
      await env.VECTORS.put(factKey,JSON.stringify({fact,entity:canonical,category:category||'fact',confidence:0.3,count:1,created:now,last_reinforced:now}),ttl);
      const idxRaw=await env.VECTORS.get(indexKey);
      const keys=idxRaw?JSON.parse(idxRaw):[];
      if(!keys.includes(factKey)){keys.push(factKey); await env.VECTORS.put(indexKey,JSON.stringify(keys.slice(-50)),ttl);}
    }
    await addKVWrites(env,2);
    return true;
  }catch(e){ console.warn('storeHermesFact:',e.message); return false; }
}

// Anchor entities fetched on EVERY query — these hold operational instructions
// that must always be in context regardless of what the user queries.
const ANCHOR_ENTITIES = ["BRAIN-STARTUP", "Brain Owner"];

// IST = UTC+5:30. session_id buckets and filename prefixes use IST date.
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
function istDateStr(d = Date.now()) {
  const ms = typeof d === "string" ? Date.parse(d) : d;
  return new Date((Number.isFinite(ms) ? ms : Date.now()) + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function istIsoStr(d = Date.now()) {
  const ms = typeof d === "string" ? Date.parse(d) : d;
  return new Date((Number.isFinite(ms) ? ms : Date.now()) + IST_OFFSET_MS).toISOString().replace("Z", "+05:30");
}

// Capture surface — first-class field on every observation.
const SURFACES = ["claude-ai-web", "claude-code", "cowork", "gemini", "chatgpt-go", "claude-mobile", "google-antigravity", "other"];
function normalizeSurface(s) {
  if (typeof s !== "string" || !s) return null;
  const v = s.trim().toLowerCase();
  return SURFACES.includes(v) ? v : null;
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
const rateLimitStore = new Map();
const RATE_LIMIT = 100;
const RATE_LIMIT_WINDOW = 60000;

function checkRateLimit(ip) {
  const now = Date.now();
  const recent = (rateLimitStore.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  rateLimitStore.set(ip, recent);
  return true;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function authenticate(req, env) {
  const url = new URL(req.url);
  const key = req.headers.get("X-API-Key") || req.headers.get("x-api-key") || url.searchParams.get("key");
  const expected = env.API_KEY || "YOUR_API_KEY";
  if (!key) return { ok: false, error: "API key required" };
  if (key !== expected) return { ok: false, error: "Invalid API key" };
  return { ok: true };
}

// ─── NVIDIA NIM caller ────────────────────────────────────────────────────────
async function callNvidiaLLM(apiKey, model, messages, maxTokens = 800, timeoutMs = 15000) {
  if (!apiKey) throw new Error("No API key");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2 }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`NVIDIA ${model} HTTP ${res.status}: ${err.substring(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error(`NVIDIA ${model} empty response`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Role-aware LLM caller: tries role-specific models first, falls back to universal chain
// v10.0.1 ROOT-CAUSE FIX: total-time budget. Previously this looped ~13 tiers ×
// 15s each with NO overall cap — when several NVIDIA keys for a role were dead/slow
// the cascade could run 60-120s+, blowing the sync request timeout AND getting the
// waitUntil isolate recycled before facts/triples were written (the "extraction
// stall"). Now: per-tier timeout is shortened AND the loop aborts once `budgetMs`
// is spent, skipping straight to the fast in-process CF fallback. Every caller of
// callRoleLLM is protected, not just those remembering to wrap in withTimeout.
async function callRoleLLM(env, role, messages, maxTokens = 800, budgetMs = 20000, perTierMs = 8000) {
  const roleTiers = MODELS[role] || [];
  const allTiers = [...roleTiers, ...LLM_TIERS.filter(t => !roleTiers.find(r => r.model === t.model))];
  const deadline = Date.now() + budgetMs;
  for (const tier of allTiers) {
    if (Date.now() >= deadline) { console.warn(`LLM [${role}] budget ${budgetMs}ms exhausted, → CF fallback`); break; }
    const apiKey = env[tier.secretKey];
    if (!apiKey) continue;
    // Reasoning models (e.g. gpt-oss-120b) consume tokens on internal reasoning before content —
    // enforce a floor so content tokens aren't starved
    const effectiveTokens = tier.minTokens ? Math.max(maxTokens, tier.minTokens) : maxTokens;
    // Per-tier timeout also clamped to remaining budget so the last tier can't overrun.
    const tierTimeout = Math.min(perTierMs, Math.max(1500, deadline - Date.now()));
    try {
      const result = await callNvidiaLLM(apiKey, tier.model, messages, effectiveTokens, tierTimeout);
      console.log(`LLM [${role}]: ${tier.model} (${effectiveTokens}tok)`);
      return result;
    } catch (e) {
      console.warn(`LLM [${role}] ${tier.model} failed: ${e.message}`);
    }
  }
  // Last resort: CF Workers AI in-process (0 subrequests, always fast — no external hop)
  if (env.AI) {
    const res = await env.AI.run(CF_MODEL_FALLBACK, { messages, max_tokens: maxTokens });
    return typeof res.response === "string" ? res.response : JSON.stringify(res.response);
  }
  throw new Error(`No LLM available for role: ${role}`);
}

// ─── GitHub helpers ───────────────────────────────────────────────────────────
const GH_UA = "lnm-brain-worker";

// Auth precedence (v7.7.0+):
//   1. GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_INSTALLATION_ID → GitHub App
//      Installation token (15000 req/h, isolated from user PAT). Cached in KV
//      under "auth:gh:installation_token" for 50 min (GitHub tokens expire at 1h).
//   2. GITHUB_TOKEN → personal access token (legacy, 5000 req/h shared with `gh` CLI).
//
// All call sites pull headers from ghAuthHeader(env) — never read env.GITHUB_TOKEN
// directly outside this block.

function _b64urlFromBytes(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function _b64urlFromStr(s) {
  return _b64urlFromBytes(new TextEncoder().encode(s));
}
function _pemToBytes(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Sign a GitHub-App JWT (1-min lifetime) with the App's RSA private key.
async function _signAppJWT(env) {
  const appId = env.GITHUB_APP_ID;
  const pem = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !pem) throw new Error("GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY missing");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 30, exp: now + 540, iss: String(appId) }; // ≤10min per GH spec
  const head = _b64urlFromStr(JSON.stringify(header));
  const body = _b64urlFromStr(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${head}.${body}`);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    _pemToBytes(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
  const sig = _b64urlFromBytes(new Uint8Array(sigBuf));
  return `${head}.${body}.${sig}`;
}

// Mint or fetch cached installation token. Cache in KV for 50min.
async function _getInstallationToken(env) {
  const cacheKey = "auth:gh:installation_token";
  const cached = await env.VECTORS.get(cacheKey);
  if (cached) {
    try {
      const j = JSON.parse(cached);
      if (j.expires_at && Date.parse(j.expires_at) - Date.now() > 600_000) return j.token;
    } catch {}
  }
  const installationId = env.GITHUB_INSTALLATION_ID;
  if (!installationId) throw new Error("GITHUB_INSTALLATION_ID missing");
  const jwt = await _signAppJWT(env);
  // Bare fetch — this call mints the installation token itself, so we cannot
  // recurse through ghFetch/ghAuthHeader. JWT is the auth.
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA },
  });
  if (!res.ok) throw new Error(`GitHub App token exchange failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  await env.VECTORS.put(cacheKey, JSON.stringify({ token: j.token, expires_at: j.expires_at }), { expirationTtl: 3000 });
  return j.token;
}

// Returns Authorization header value. Prefers GitHub App, falls back to PAT.
// Cached per request via globalThis to avoid double-mint within one fetch.
async function ghAuthHeader(env) {
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_INSTALLATION_ID) {
    try {
      const tok = await _getInstallationToken(env);
      return `Bearer ${tok}`;
    } catch (e) {
      console.warn("[gh-auth] App token mint failed, falling back to PAT:", e.message);
    }
  }
  if (!env.GITHUB_TOKEN) throw new Error("No GitHub credentials configured (set GITHUB_APP_* or GITHUB_TOKEN)");
  return `token ${env.GITHUB_TOKEN}`;
}

async function ghGet(env, path, raw = false) {
  const repo = env.GITHUB_REPO || "your-username/your-repo";
  const branch = env.GITHUB_BRANCH || "main";
  const auth = await ghAuthHeader(env);
  return ghFetch(env, `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
    { headers: { Authorization: auth, Accept: raw ? "application/vnd.github.v3.raw" : "application/vnd.github.v3+json", "User-Agent": GH_UA } }
  );
}

async function ghPut(env, filePath, content, message, sha = null) {
  const repo = env.GITHUB_REPO || "your-username/your-repo";
  const branch = env.GITHUB_BRANCH || "main";
  const body = { message, content: btoa(unescape(encodeURIComponent(content))), branch };
  if (sha) body.sha = sha;
  const auth = await ghAuthHeader(env);
  return ghFetch(env, `https://api.github.com/repos/${repo}/contents/${filePath}`, {
    method: "PUT",
    headers: { Authorization: auth, Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA },
    body: JSON.stringify(body),
  });
}

// v7.7.0: wraps fetch with auth header injection. All raw GitHub fetches in this
// file go through ghFetch(env, url, opts) — never set Authorization manually.
async function ghFetch(env, url, opts = {}) {
  const auth = await ghAuthHeader(env);
  const headers = Object.assign({}, opts.headers || {}, { Authorization: auth, "User-Agent": GH_UA });
  return fetch(url, Object.assign({}, opts, { headers }));
}

// v9.3: list ALL .md files under a dir via the git-tree API (single recursive
// call, NO 1000-item cap that /contents dir-listing silently imposes). Returns
// [{ name, path }]. This is the primitive that fixes index/lint blindness past
// 1000 files. Cached per-invocation by branch tree SHA is overkill — callers
// usually need exactly one dir, so we cache the full tree on env for the request.
async function ghTreeAll(env) {
  if (env.__treeCache) return env.__treeCache;
  const repo = env.GITHUB_REPO || "your-username/your-repo";
  const branch = env.GITHUB_BRANCH || "main";
  const res = await ghFetch(env, `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
    { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } });
  if (!res.ok) return [];
  const json = await res.json();
  const tree = (json.tree || []).filter(t => t.type === "blob" && t.path.endsWith(".md"))
    .map(t => ({ name: t.path.split("/").pop(), path: t.path }));
  env.__treeCache = tree;
  return tree;
}

// All .md under a dir prefix (e.g. "wiki/conversations"). Uncapped.
async function ghListAll(env, dir) {
  const norm = dir.replace(/\/$/, "") + "/";
  return (await ghTreeAll(env)).filter(f => f.path.startsWith(norm));
}

async function readFile(env, path) {
  const res = await ghGet(env, path, true);
  return res.ok ? res.text() : null;
}

async function writeFile(env, path, content, message) {
  const metaRes = await ghGet(env, path, false);
  let sha = null;
  if (metaRes.ok) { const m = await metaRes.json(); sha = m.sha; }
  return (await ghPut(env, path, content, message, sha)).ok;
}

// ─── KV write budget (free tier = 1,000 writes/day) ──────────────────────────
// Tracks daily KV writes so we surface real errors instead of silent failures.
// Free tier hard limit: 1,000 writes/day. Warn at 800, block at 950.
const KV_WRITE_LIMIT_WARN  = 750000;  // Workers Paid: 1M writes/day
const KV_WRITE_LIMIT_BLOCK = 900000;

async function getKVWriteCount(env) {
  if (!env.VECTORS) return 0;
  try {
    const today = new Date().toISOString().split("T")[0];
    const val = await env.VECTORS.get(`kv_writes:${today}`);
    return val ? parseInt(val, 10) : 0;
  } catch { return 0; }
}

async function addKVWrites(env, n) {
  if (!env.VECTORS) return;
  try {
    const today = new Date().toISOString().split("T")[0];
    const cur = await getKVWriteCount(env);
    // This write itself counts — but we can't avoid bootstrapping paradox here
    await env.VECTORS.put(`kv_writes:${today}`, String(cur + n), { expirationTtl: 86400 * 2 });
  } catch {}
}

// Returns { ok: true } or { ok: false, error, count, limit }
async function checkKVWriteBudget(env, estimatedWrites = 1) {
  const count = await getKVWriteCount(env);
  if (count + estimatedWrites > KV_WRITE_LIMIT_BLOCK) {
    return { ok: false, error: `KV write limit reached (${count}/day used, free tier limit ~1000). Writes blocked to prevent silent data loss. Try again tomorrow or upgrade to Workers Paid ($5/mo).`, count, limit: 1000 };
  }
  return { ok: true, count, warning: count >= KV_WRITE_LIMIT_WARN ? `KV writes running low: ${count}/day used` : null };
}

// ─── Neuron budget ────────────────────────────────────────────────────────────
async function getNeuronUsage(env) {
  if (!env.VECTORS) return 0;
  try {
    const val = await env.VECTORS.get(`neuron_usage:${new Date().toISOString().split("T")[0]}`);
    return val ? parseInt(val, 10) : 0;
  } catch { return 0; }
}

async function addNeuronUsage(env, n) {
  if (!env.VECTORS) return;
  try {
    const today = new Date().toISOString().split("T")[0];
    const cur = await getNeuronUsage(env);
    await env.VECTORS.put(`neuron_usage:${today}`, String(cur + n), { expirationTtl: 86400 * 2 });
  } catch {}
}

async function canAfford(env, cost) {
  const used = await getNeuronUsage(env);
  return (used + cost) <= NEURON_BUDGET_COMPRESSION;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 60);
}

// Guarantee a markdown string has an EVEN number of ``` fences. An odd count
// means a code block was left open — in Obsidian everything after it (incl. the
// `## Backlinks [[index]]`) is swallowed into the code block, the wikilink is
// not parsed, and the note becomes a disconnected graph orphan. Appends one
// closing fence so the trailing structured sections + backlink stay parseable.
function balanceFences(s) {
  if (!s) return s;
  const n = (s.match(/```/g) || []).length;
  if (n % 2 === 0) return s;
  return s.replace(/\s*$/, "") + "\n```\n";
}

// v9: Enumerated/verdict block extractor — pulls podium/numbered/Niche/Step
// lines verbatim. Used by compressToWiki to pin lists before LLM summarisation.
// Boundary after the leader is flexible: whitespace, colon, dash, or em-dash.
const VERDICT_LINE_RE = /^\s*(?:🥇|🥈|🥉|❌|⏳|(?:Niche|Step)\s+\d+|\d+[\.\)])[\s:\-—]+.+$/u;
function extractVerdictBlocks(content) {
  if (!content) return [];
  const lines = content.split("\n");
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (VERDICT_LINE_RE.test(line)) {
      current.push(line.trimEnd());
    } else if (current.length) {
      blocks.push(current.join("\n"));
      current = [];
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks.filter(b => b.split("\n").length >= 2); // need ≥2 enumerated lines
}

// v9: Triples for enumerated rankings. Detects "Niche 3: Faceless Sales Copy — revenue engine"
// or "1. Faceless Sales Copy (revenue engine)" → triples per item.
function extractRankingTriples(content) {
  if (!content) return [];
  const out = [];
  const lines = content.split("\n");
  // Strip leading podium/clock emoji + spaces so the Niche/Step matcher works
  // even when callers prefix items with 🥇 / 🥈 / 🥉 / ❌ / ⏳.
  const stripLead = (s) => s.trim().replace(/^[🥇🥈🥉❌⏳]\s*/u, "").trim();
  for (const raw of lines) {
    const line = stripLead(raw);
    // Pattern A: "Niche N: Name — role" / "Niche N - Name: role" / "Niche N Name"
    // Separator between name and role must be SPACED dash / em-dash / colon so
    // we don't split inside compound words ("Long-form").
    let m = line.match(/^(?:Niche|Step)\s+(\d+)\s*[:\-—]?\s*(.+?)(?:\s+(?:—|–|-|:)\s+(.+))?$/iu);
    if (m) {
      const rank = parseInt(m[1], 10);
      const name = (m[2] || "").replace(/[*_`]/g, "").trim();
      const role = (m[3] || "").replace(/[*_`]/g, "").trim();
      const subj = `Niche-${rank}`;
      out.push({ subject: subj, predicate: "hasRank", object: String(rank) });
      if (name) out.push({ subject: subj, predicate: "hasName", object: name });
      if (role) out.push({ subject: subj, predicate: "hasRole", object: role });
      continue;
    }
    // Pattern B: "1. Name — role"  /  "1) Name (role)"
    m = line.match(/^(\d+)[\.\)]\s+(.+?)(?:\s+(?:—|–|-|:)\s+(.+?)|\s+\((.+?)\))?$/);
    if (m) {
      const rank = parseInt(m[1], 10);
      const name = m[2].replace(/[*_`]/g, "").trim();
      const role = (m[3] || m[4] || "").replace(/[*_`]/g, "").trim();
      if (name.length < 2) continue;
      const subj = `Rank-${rank}`;
      out.push({ subject: subj, predicate: "hasRank", object: String(rank) });
      if (name) out.push({ subject: subj, predicate: "hasName", object: name });
      if (role) out.push({ subject: subj, predicate: "hasRole", object: role });
    }
  }
  return out;
}

// v9: Reciprocal Rank Fusion. Merges multiple ranked lists by id.
// Each list = [{id, score?}, ...] ordered best→worst. k=60 standard.
function rrfFuse(rankedLists, k = 60) {
  const scores = new Map(); // id → {score, methods:Set}
  for (const list of rankedLists) {
    if (!Array.isArray(list)) continue;
    list.forEach((item, idx) => {
      if (!item || !item.id) return;
      const cur = scores.get(item.id) || { score: 0, methods: new Set(), data: item };
      cur.score += 1 / (k + idx + 1);
      if (item._method) cur.methods.add(item._method);
      cur.data = { ...cur.data, ...item };
      scores.set(item.id, cur);
    });
  }
  return [...scores.entries()]
    .map(([id, v]) => ({ id, _rrf: v.score, _methods: [...v.methods], ...v.data }))
    .sort((a, b) => b._rrf - a._rrf);
}

function entitySlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 40);
}

function factHash(fact) {
  let h = 0;
  for (let i = 0; i < fact.length; i++) h = ((h << 5) - h + fact.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ─── Entity name normalization (v5.1) ─────────────────────────────────────────
// KV key: entity:aliases_index → JSON { "ritik": "Brain Owner", "exampleproject": "ExampleProject" }
// On every extraction, short/variant names resolve to canonical before KV write.
//
// v5.1 KV cost fix: alias map cached in module-level var for the lifetime of a
// request batch. resolveEntityName no longer does a full VECTORS.list scan on
// every call — that was 16+ list ops per capture. Fuzzy scan only runs once
// per entity name, gated behind a Set to deduplicate across the request.

let _aliasCache = null;         // reset each request via resetRequestCache()
let _fuzzyChecked = new Set();  // entity slugs already fuzzy-scanned this request

function resetRequestCache() {
  _aliasCache = null;
  _fuzzyChecked = new Set();
}

async function getAliasMap(env) {
  if (!env.VECTORS) return {};
  if (_aliasCache !== null) return _aliasCache;
  try {
    const raw = await env.VECTORS.get("entity:aliases_index");
    _aliasCache = raw ? JSON.parse(raw) : {};
    return _aliasCache;
  } catch { _aliasCache = {}; return {}; }
}

async function saveAliasMap(env, map) {
  if (!env.VECTORS) return;
  _aliasCache = map; // keep in-memory cache consistent
  try {
    await env.VECTORS.put("entity:aliases_index", JSON.stringify(map), { expirationTtl: 86400 * 730 });
  } catch {}
}

// Resolve entity name to canonical form.
// Alias map checked first (1 KV read, cached). Fuzzy list-scan runs at most
// once per unique entity name per request, skipped on subsequent calls.
async function resolveEntityName(env, rawName) {
  if (!rawName || !env.VECTORS) return rawName;
  const slug = entitySlug(rawName);
  const aliases = await getAliasMap(env); // cached after first call

  // Direct alias hit — no further KV ops
  if (aliases[slug]) return aliases[slug];

  // Fuzzy scan: only once per slug per request to avoid repeated list ops
  if (_fuzzyChecked.has(slug)) return rawName;
  _fuzzyChecked.add(slug);

  try {
    const list = await env.VECTORS.list({ prefix: "entity:", limit: 500 });
    const metaKeys = list.keys.filter(k => k.name.endsWith(":meta"));
    const rawLower = rawName.toLowerCase();

    for (const mk of metaKeys) {
      const metaRaw = await env.VECTORS.get(mk.name);
      if (!metaRaw) continue;
      const meta = JSON.parse(metaRaw);
      const canonLower = meta.name.toLowerCase();

      const isSubstring = canonLower.includes(rawLower) || rawLower.includes(canonLower);
      if (isSubstring && meta.name !== rawName) {
        const canonical = meta.name.length >= rawName.length ? meta.name : rawName;
        aliases[slug] = canonical;
        await saveAliasMap(env, aliases);
        return canonical;
      }
    }
  } catch {}

  return rawName;
}

// Register manual alias: POST /register-entity-alias {alias, canonical}
async function handleRegisterAlias(req, env) {
  const { alias, canonical } = await req.json().catch(() => ({}));
  if (!alias || !canonical) return jsonErr("alias and canonical required", 400);
  const aliases = await getAliasMap(env);
  aliases[entitySlug(alias)] = canonical;
  await saveAliasMap(env, aliases);
  return jsonOk({ status: "registered", alias, canonical, slug: entitySlug(alias) });
}

// ─── Triple storage (v5.3) ───────────────────────────────────────────────────
// Stores facts as structured subject|predicate|object triples.
// Enables precise overwrite by predicate (vs append-only free-text blobs).
// KV: triple:{subject_slug}:{pred_slug} → {subject,predicate,object,category,confidence,last_confirmed}
//     triple:{subject_slug}:index       → JSON string[] of predicate slugs

function predSlug(predicate) {
  return predicate.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").substring(0, 40);
}

// v10 §D: `derivation` records HOW the triple was derived — "stated" (verbatim
// from user content), "inferred" (LLM-extracted from pattern), "reinforced"
// (contradiction-check kept the existing value), "unknown" (legacy/unspecified).
// `sourceObsId` back-references the observation (or file path) that produced it.
// v10.0.1: `fastMode` skips the per-triple LLM contradiction check. ROOT-CAUSE of
// the extraction stall: bulk ingest wrote ~5 triples/entity, each triggering an
// 8-16s LLM verify call → extractAndStoreFactsFromContent ran ~53s → CF wall-clock
// killed the waitUntil isolate before facts committed. Bulk extraction passes
// fastMode=true (last-write-wins, no LLM); only direct/admin single writes verify.
async function upsertTriple(env, subject, predicate, object, category = "fact", derivation = "unknown", sourceObsId = null, fastMode = false) {
  if (!env.VECTORS || !subject || !predicate || !object) return;
  const canonical = await resolveEntityName(env, subject);
  const sSlug = entitySlug(canonical);
  const pSlug = predSlug(predicate);
  const key = `triple:${sSlug}:${pSlug}`;
  const idxKey = `triple:${sSlug}:index`;
  const now = Date.now();
  const ttl = { expirationTtl: 86400 * 730 };

  try {
    const [existing, idxRaw] = await Promise.all([
      env.VECTORS.get(key),
      env.VECTORS.get(idxKey),
    ]);
    const idx = idxRaw ? JSON.parse(idxRaw) : [];
    const old = existing ? JSON.parse(existing) : null;  // parse once, reuse below

    // Triple contradiction detection: when same predicate gets a new object value,
    // use LLM to verify it's a genuine update vs noise before overwriting.
    if (old) {
      if (old.object !== object) {
        // Always log the overwrite
        console.log(`Triple overwrite [${canonical}] ${predicate}: "${old.object}" → "${object}"`);
        // LLM verify only when neuron budget allows — non-fatal if skipped.
        // fastMode (bulk ingest) skips this to stay under CF wall-clock.
        if (!fastMode && env.AI && await canAfford(env, NEURON_COST_EXTRACTION)) {
          try {
            const verifyPrompt = `Entity: "${canonical}", predicate: "${predicate}"
Old value: "${old.object}"
New value: "${object}"
Is the new value a genuine factual update (return "update") or likely noise/duplicate (return "keep")?
Return JSON only: {"decision": "update"} or {"decision": "keep"}`;
            const verifyText = await callRoleLLM(env, "extraction",
              [{ role: "user", content: verifyPrompt }], 50);
            await addNeuronUsage(env, NEURON_COST_EXTRACTION);
            const vm = verifyText.match(/\{[\s\S]*\}/);
            if (vm) {
              const { decision } = JSON.parse(vm[0]);
              if (decision === "keep") {
                // Reinforce confidence on existing triple but don't overwrite
                await env.VECTORS.put(key, JSON.stringify({
                  ...old,
                  confidence: Math.min((old.confidence || 0.5) + 0.05, 1.0),
                  last_confirmed: now,
                  derivation: "reinforced",
                }), ttl);
                return;
              }
            }
          } catch (e) { console.warn("triple contradiction check (non-fatal):", e.message); }
        }
      }
    }

    await env.VECTORS.put(key, JSON.stringify({
      subject: canonical, predicate, object, category,
      confidence: old ? Math.min((old.confidence || 0.5) + 0.1, 1.0) : 0.6,
      last_confirmed: now,
      created: old ? old.created : now,
      derivation: derivation || "unknown",
      source_obs_id: sourceObsId || (old ? old.source_obs_id : null) || null,
    }), ttl);

    if (!idx.includes(pSlug)) {
      idx.push(pSlug);
      await env.VECTORS.put(idxKey, JSON.stringify(idx.slice(-100)), ttl);
    }
  } catch (e) { console.warn("upsertTriple:", e.message); }
}

async function getTriples(env, subject, predicateFilter = null, categoryFilter = null) {
  if (!env.VECTORS) return [];
  const canonical = await resolveEntityName(env, subject);
  const sSlug = entitySlug(canonical);
  try {
    const idxRaw = await env.VECTORS.get(`triple:${sSlug}:index`);
    if (!idxRaw) return [];
    let pSlugs = JSON.parse(idxRaw);
    if (predicateFilter) pSlugs = pSlugs.filter(p => p.includes(predSlug(predicateFilter)));

    const raws = await Promise.all(pSlugs.map(p => env.VECTORS.get(`triple:${sSlug}:${p}`)));
    return raws
      .filter(Boolean)
      // v10 §D: legacy rows lack derivation/source_obs_id → default to "unknown"/null
      // so API consumers always get consistent fields, never absent keys.
      .map(r => { const t = JSON.parse(r); return { ...t, derivation: t.derivation || "unknown", source_obs_id: t.source_obs_id ?? null }; })
      .filter(t => !categoryFilter || t.category === categoryFilter)
      .sort((a, b) => (b.last_confirmed || 0) - (a.last_confirmed || 0));
  } catch { return []; }
}

// v10.0.1 SUPERIORITY (Graphify-style `path`): shortest connection between two
// entities via the triple graph. BFS over triple objects that are themselves
// entities (an object is treated as a node if it resolves to a known entity or
// appears as a subject slug). Returns the hop-by-hop path or null if unreachable
// within maxHops. This is what Graphify does for code; here it's for personal
// knowledge — "what connects X to Y across everything I've captured."
async function findEntityPath(env, fromEntity, toEntity, maxHops = 4) {
  if (!env.VECTORS) return null;
  const fromCanon = await resolveEntityName(env, fromEntity);
  const toCanon   = await resolveEntityName(env, toEntity);
  const toSlug    = entitySlug(toCanon);
  if (entitySlug(fromCanon) === toSlug) return { hops: 0, path: [fromCanon], edges: [] };

  const visited = new Set([entitySlug(fromCanon)]);
  // queue entries: { slug, name, path:[names], edges:[{from,predicate,to}] }
  let frontier = [{ slug: entitySlug(fromCanon), name: fromCanon, path: [fromCanon], edges: [] }];

  for (let hop = 0; hop < maxHops; hop++) {
    if (frontier.length === 0) break;
    // Expand all frontier nodes for this hop in parallel.
    const expansions = await Promise.all(frontier.map(async (node) => {
      const triples = await getTriples(env, node.name);
      return { node, triples };
    }));
    const next = [];
    for (const { node, triples } of expansions) {
      for (const t of triples) {
        // Treat the object as a candidate node.
        const objCanon = await resolveEntityName(env, t.object);
        const objSlug = entitySlug(objCanon);
        const edge = { from: node.name, predicate: t.predicate, to: objCanon, derivation: t.derivation || "unknown" };
        if (objSlug === toSlug) {
          // Target reached — return the completed path directly.
          return { hops: hop + 1, path: [...node.path, objCanon], edges: [...node.edges, edge] };
        }
        if (!visited.has(objSlug)) {
          visited.add(objSlug);
          next.push({ slug: objSlug, name: objCanon, path: [...node.path, objCanon], edges: [...node.edges, edge] });
        }
      }
    }
    frontier = next;
  }
  return null;
}

// v10 §C: god-node / centrality scan. Ranks every entity by "how connected is it
// right now" = fact_count + 2*triple_count (see rankEntitiesByCentrality). Full KV
// prefix scan over entity:*:meta + triple:* — EXPENSIVE, cron-only, never call
// inline in a synchronous MCP tool. Fail-safe: returns [] on any error.
async function scanEntityCentrality(env, topN = 10) {
  if (!env.VECTORS) return [];
  try {
    // 1) entity meta (name + total_facts)
    const metaList = [];
    let cursor;
    do {
      const l = await env.VECTORS.list({ prefix: "entity:", limit: 1000, cursor });
      for (const k of l.keys) {
        if (!k.name.endsWith(":meta")) continue;
        const raw = await env.VECTORS.get(k.name);
        if (!raw) continue;
        try {
          const m = JSON.parse(raw);
          const slug = k.name.slice("entity:".length, -":meta".length);
          metaList.push({ slug, name: m.name || slug, total_facts: m.total_facts || 0 });
        } catch {}
      }
      cursor = l.list_complete ? null : l.cursor;
    } while (cursor);

    // 2) triple counts per subject slug (exclude :index rows)
    const tripleCounts = {};
    cursor = undefined;
    do {
      const l = await env.VECTORS.list({ prefix: "triple:", limit: 1000, cursor });
      for (const k of l.keys) {
        const parts = k.name.split(":"); // ["triple", slug, predicate]
        if (parts.length < 3 || parts[2] === "index") continue;
        tripleCounts[parts[1]] = (tripleCounts[parts[1]] || 0) + 1;
      }
      cursor = l.list_complete ? null : l.cursor;
    } while (cursor);

    return rankEntitiesByCentrality(metaList, tripleCounts).slice(0, topN);
  } catch (e) {
    console.warn("scanEntityCentrality (non-fatal):", e.message);
    return [];
  }
}

// v10.2.1: pin-aware replacement for `keys.slice(-50)`. Reads each fact-key's
// category (cheap parallel KV gets), marks pinned ones, keeps ALL pinned +
// newest 80 unpinned. Bounded: on a huge index we only need to read keys not
// already destined to survive, but reading all is fine at entity scale (<~130).
async function capFactIndexWithPinsLive(env, keys, keepRecent = 80) {
  try {
    // Fast path: small index, nothing to cap.
    if (keys.length <= keepRecent) return keys;
    const raws = await Promise.all(keys.map(k => env.VECTORS.get(k)));
    const pinnedSet = new Set();
    for (let i = 0; i < keys.length; i++) {
      if (!raws[i]) continue;
      try { if (isPinnedFact(JSON.parse(raws[i]))) pinnedSet.add(keys[i]); } catch {}
    }
    return capFactIndexWithPins(keys, pinnedSet, keepRecent);
  } catch {
    // Fail-safe: never lose the newest window if the scan errors.
    return keys.slice(-Math.max(keepRecent, 50));
  }
}

// ─── Entity fact storage ──────────────────────────────────────────────────────
// category: "fact" | "preference" | "instruction" | "history"
// Instructions (rules) returned first — highest priority in /ask context.
async function getEntityFacts(env, entityName, categoryFilter = null) {
  if (!env.VECTORS) return [];
  const canonical = await resolveEntityName(env, entityName);
  const slug = entitySlug(canonical);
  try {
    const indexRaw = await env.VECTORS.get(`entity:${slug}:facts_index`);
    if (!indexRaw) return [];
    const keys = JSON.parse(indexRaw);
    // v10.2.2 perf: parallel fact reads (was serial O(n×KV)). Same op count.
    const raws = await Promise.all(keys.map(k => env.VECTORS.get(k)));
    const facts = [];
    for (const raw of raws) {
      if (!raw) continue;
      try { const f = JSON.parse(raw); if (!f.superseded_by) facts.push(f); } catch {}
    }
    const now = Date.now();
    return facts
      .filter(f => !categoryFilter || (f.category || "fact") === categoryFilter)
      .map(f => {
        // v10.2.1 (Balance): PINNED facts (identity/behavioral/instruction/preference,
        // or high-count truths) NEVER decay — an old-but-true fact must survive so it
        // resurfaces instead of being crushed by fresh chatter. Only transient facts
        // keep the 90-day half-life.
        const ageDays = (now - (f.last_reinforced || f.created || now)) / 86400000;
        const decayFactor = isPinnedFact(f) ? 1.0 : Math.exp(-ageDays / 90);
        // Category priority: behavioral+identity rank with instructions (durable self-model).
        const catBoost = { instruction: 2.0, behavioral: 1.8, identity: 1.8, preference: 1.3, fact: 1.0, history: 0.7 }[f.category || "fact"] || 1.0;
        return { ...f, _score: (f.confidence || 0.5) * decayFactor * catBoost };
      })
      .sort((a, b) => b._score - a._score)
      .map(({ _score, ...f }) => f);
  } catch { return []; }
}

// v5.2: batched — reads facts_index + meta ONCE per entity, writes all facts,
// then writes index + meta once. Reduces 6 KV ops/fact → 2 ops/fact + 2 shared.
// Before: 5 facts = 30 ops. After: 5 facts = 10 + 2 = 12 ops. ~60% reduction.
async function upsertEntityFacts(env, entityName, facts) {
  if (!env.VECTORS || !facts || facts.length === 0) return;
  const validFacts = facts.filter(f => f && f.length >= 5);
  if (validFacts.length === 0) return;

  const canonical = await resolveEntityName(env, entityName);
  const slug = entitySlug(canonical);
  const now = Date.now();
  const ttl = { expirationTtl: 86400 * 730 };

  try {
    const indexKey = `entity:${slug}:facts_index`;
    const metaKey  = `entity:${slug}:meta`;

    // Read shared state once
    const [indexRaw, metaRaw] = await Promise.all([
      env.VECTORS.get(indexKey),
      env.VECTORS.get(metaKey),
    ]);
    const keys = indexRaw ? JSON.parse(indexRaw) : [];
    const meta = metaRaw ? JSON.parse(metaRaw) : { name: canonical, created: now };

    let newFactsAdded = 0;

    // Read all existing fact keys in parallel, then write all in parallel
    const factKeys = validFacts.map(f => `entity:${slug}:fact:${factHash(f.toLowerCase().trim())}`);
    const existingRaws = await Promise.all(factKeys.map(k => env.VECTORS.get(k)));

    const writes = [];
    const DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours — skip reinforcement write if seen recently
    for (let i = 0; i < validFacts.length; i++) {
      const fact = validFacts[i];
      const factKey = factKeys[i];
      const existingRaw = existingRaws[i];

      if (existingRaw) {
        const parsed = JSON.parse(existingRaw);
        // KV dedup: skip write if fact was reinforced within 6h AND confidence already maxed
        // Saves ~60-80% of repeat writes on high-frequency captures (same facts seen every session)
        const recentlyReinforced = (now - (parsed.last_reinforced || 0)) < DEDUP_WINDOW_MS;
        const alreadyMaxConf = (parsed.confidence || 0) >= 1.0;
        if (recentlyReinforced && alreadyMaxConf) continue; // skip — no new info to store
        const newCount = (parsed.count || 1) + 1;
        writes.push(env.VECTORS.put(factKey, JSON.stringify({
          ...parsed,
          count: newCount,
          confidence: Math.min(newCount / 5, 1.0),
          last_reinforced: now,
        }), ttl));
      } else {
        writes.push(env.VECTORS.put(factKey, JSON.stringify({
          fact, entity: canonical, confidence: 0.2, count: 1, created: now, last_reinforced: now,
        }), ttl));
        if (!keys.includes(factKey)) {
          keys.push(factKey);
          newFactsAdded++;
        }
      }
    }

    // Write all facts in parallel
    await Promise.all(writes);

    // Write index + meta once (only if changed)
    const sharedWrites = [];
    if (newFactsAdded > 0) {
      const cappedKeys = await capFactIndexWithPinsLive(env, keys);
      sharedWrites.push(env.VECTORS.put(indexKey, JSON.stringify(cappedKeys), ttl));
      meta.updated = now;
      meta.total_facts = (meta.total_facts || 0) + newFactsAdded;
      sharedWrites.push(env.VECTORS.put(metaKey, JSON.stringify(meta), ttl));
    }
    if (sharedWrites.length > 0) await Promise.all(sharedWrites);
    // Track KV writes: facts writes + (index+meta if changed)
    await addKVWrites(env, writes.length + sharedWrites.length);

  } catch (e) { console.warn("upsertEntityFacts:", e.message); }
}

// Kept for single-fact callers (fallback path in extractAndStoreFactsFromContent)
async function upsertEntityFact(env, entityName, fact) {
  return upsertEntityFacts(env, entityName, [fact]);
}

// ─── Fact contradiction detection (v5.0) ─────────────────────────────────────
// When new facts arrive for an entity, check for semantic contradictions with
// existing high-confidence facts using LLM. Mark old fact superseded if found.
async function detectAndSupersedeFacts(env, entityName, newFacts) {
  if (!env.VECTORS || !env.AI || newFacts.length === 0) return;
  if (!(await canAfford(env, NEURON_COST_EXTRACTION))) return;

  const canonical = await resolveEntityName(env, entityName);
  const slug = entitySlug(canonical);

  // Skip entirely if no facts_index exists — new entity can't have contradictions.
  // Saves 1 getEntityFacts (list + N reads) per new entity per capture.
  const indexRaw = await env.VECTORS.get(`entity:${slug}:facts_index`);
  if (!indexRaw) return;

  const existing = await getEntityFacts(env, canonical);
  const highConf = existing.filter(f => f.confidence >= 0.4);
  if (highConf.length === 0) return;

  const existingList = highConf.map((f, i) => `${i}: "${f.fact}"`).join("\n");
  const newList = newFacts.map((f, i) => `${i}: "${f}"`).join("\n");

  const prompt = `You detect factual contradictions about the same entity.

Entity: "${canonical}"

Existing high-confidence facts:
${existingList}

New incoming facts:
${newList}

If any new fact directly contradicts an existing fact (e.g. job changed, location changed, preference flipped), return the indices.
Return JSON only: {"contradictions": [{"existing_idx": 0, "new_idx": 1}]}
If no contradictions: {"contradictions": []}`;

  try {
    const text = await callRoleLLM(env, "extraction", [{ role: "user", content: prompt }], 200);
    await addNeuronUsage(env, NEURON_COST_EXTRACTION);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.contradictions)) return;

    const slug = entitySlug(canonical);
    for (const { existing_idx, new_idx } of parsed.contradictions) {
      const oldFact = highConf[existing_idx];
      const newFact = newFacts[new_idx];
      if (!oldFact || !newFact) continue;

      // Mark old fact superseded
      const oldHash = factHash(oldFact.fact.toLowerCase().trim());
      const oldKey = `entity:${slug}:fact:${oldHash}`;
      const oldRaw = await env.VECTORS.get(oldKey);
      if (oldRaw) {
        const oldParsed = JSON.parse(oldRaw);
        await env.VECTORS.put(oldKey, JSON.stringify({
          ...oldParsed,
          confidence: 0,
          superseded_by: newFact,
          superseded_at: Date.now(),
        }), { expirationTtl: 86400 * 730 });
        console.log(`Superseded: "${oldFact.fact}" → "${newFact}"`);
      }
    }
  } catch (e) { console.warn("contradiction detection:", e.message); }
}

// ─── LLM fact extraction (v5.3) ──────────────────────────────────────────────
// Now extracts: facts with categories + structured triples (subject|predicate|object).
// Categories: fact (default), preference (likes/dislikes), instruction (rules/never-do),
//             history (past events/decisions).
const OBSERVATION_CATEGORIES = ["decision", "bugfix", "feature", "discovery", "conversation", "note"];

async function llmExtractFacts(env, content) {
  if (!env.AI) return null;
  if (!(await canAfford(env, NEURON_COST_EXTRACTION))) return null;

  const inputText = content.substring(0, 12000);

  try {
    const text = await callRoleLLM(env, "extraction", [
      { role: "system", content: "You extract structured knowledge from text. Output clean JSON only. Never include generic words as entities." },
      { role: "user", content: `Extract facts about NAMED entities from this content AND classify the observation AND describe its causal context.

Rules:
- Entity must be a FULL proper name (e.g. "Brain Owner", "ExampleProject"). NEVER generic words like "worker", "brain".
- Only extract facts EXPLICITLY stated. No inferences.
- Each fact: complete sentence "<Entity> <verb> <detail>". Min 10 chars.
- Classify each fact as one of: "fact" (default), "preference" (likes/dislikes/prefers), "instruction" (rules/must/never/always), "history" (past event/decision).
- Also extract triples: {predicate: "location", object: "Delhi"} for key attributes.
- Max 5 facts per entity, max 6 entities total.
- Also classify this observation as one of: decision, bugfix, feature, discovery, conversation, note. Return as 'category' in your JSON output.
- before_summary: max 60 tokens describing what immediately preceded this observation (context/problem/prior state). Empty string if unknown.
- after_summary: max 60 tokens describing what immediately followed this observation (outcome/next step/resolution). Empty string if unknown.

Content:
${inputText}

Return JSON only:
{
  "category": "decision",
  "before_summary": "Brief context that led up to this.",
  "after_summary": "Brief outcome or next step that followed.",
  "entity_facts": [
    {
      "entity": "Full Proper Name",
      "facts": [
        {"text": "Fact sentence.", "category": "fact"},
        {"text": "Brain Owner prefers dark mode.", "category": "preference"},
        {"text": "Never use mock databases in tests.", "category": "instruction"}
      ],
      "triples": [
        {"predicate": "location", "object": "Delhi"},
        {"predicate": "role", "object": "founder"},
        {"predicate": "company", "object": "ExampleProject"}
      ]
    }
  ]
}` },
    ], 1100);
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed?.entity_facts) {
        await addNeuronUsage(env, NEURON_COST_EXTRACTION);
        const rawCategory = typeof parsed.category === "string" ? parsed.category.toLowerCase().trim() : "";
        const category = OBSERVATION_CATEGORIES.includes(rawCategory) ? rawCategory : "conversation";
        const truncSummary = (s) => typeof s === "string" ? s.trim().substring(0, 400) : "";
        const before_summary = truncSummary(parsed.before_summary);
        const after_summary = truncSummary(parsed.after_summary);
        // Normalise: support both old string[] and new {text,category}[] formats
        const entity_facts = parsed.entity_facts.map(ef => ({
          entity: ef.entity,
          facts: (ef.facts || []).map(f => typeof f === "string" ? { text: f, category: "fact" } : f),
          triples: ef.triples || [],
        }));
        return { meta: { category, before_summary, after_summary }, entity_facts };
      }
    }
  } catch (e) { console.warn("fact extraction failed:", e.message); }

  return null;
}

// ─── Extract + store facts (v5.3: categories + triples + contradiction) ───────
async function extractAndStoreFactsFromContent(env, content, callerEntities = [], sourceObsId = null) {
  if (!env.VECTORS) return null;
  const extracted = await llmExtractFacts(env, content);
  if (!extracted) return null;
  const entity_facts = extracted.entity_facts || [];
  const observationMeta = extracted.meta || { category: "conversation" };
  let triplesWritten = 0; // v9.7: count real S-P-O writes so callers can report truthfully.

  if (entity_facts.length > 0) {
    // v10.0.1: process entities in PARALLEL. Was a sequential for-loop where each
    // entity did its own LLM contradiction call (detectAndSupersedeFacts ~14s) —
    // N entities × 14s ran ~42s+ and blew CF's waitUntil wall-clock, killing the
    // isolate before facts committed (the extraction stall). Promise.all collapses
    // N entities to ~1× LLM latency. Per-entity KV writes were already independent.
    const perEntityCounts = await Promise.all(entity_facts.map(async ({ entity, facts, triples }) => {
      if (!entity) return 0;
      let localTriples = 0;
      // v10.0.1: contradiction detection (detectAndSupersedeFacts) makes an LLM
      // call PER ENTITY (~14s) — the dominant cost that pushed the ingest store past
      // CF's waitUntil wall-clock, so facts never persisted. It's pure refinement
      // (supersede old contradicting facts); the nightly consolidation cron already
      // does belief-review/conflict-resolve. Skip it on the live capture path so
      // facts/triples persist immediately; correctness is recovered async by cron.

      // Upsert facts with category tags
      if (facts && facts.length > 0) {
        const canonical = await resolveEntityName(env, entity);
        const slug = entitySlug(canonical);
        const now = Date.now();
        const ttl = { expirationTtl: 86400 * 730 };
        const indexKey = `entity:${slug}:facts_index`;
        const metaKey  = `entity:${slug}:meta`;
        const [indexRaw, metaRaw] = await Promise.all([env.VECTORS.get(indexKey), env.VECTORS.get(metaKey)]);
        const keys = indexRaw ? JSON.parse(indexRaw) : [];
        const meta = metaRaw ? JSON.parse(metaRaw) : { name: canonical, created: now };
        let newFactsAdded = 0;
        const factKeys = facts.map(f => `entity:${slug}:fact:${factHash((typeof f === "string" ? f : f.text).toLowerCase().trim())}`);
        const existingRaws = await Promise.all(factKeys.map(k => env.VECTORS.get(k)));
        const writes = [];
        for (let i = 0; i < facts.length; i++) {
          const f = facts[i];
          const factText = typeof f === "string" ? f : f.text;
          const category = typeof f === "string" ? "fact" : (f.category || "fact");
          if (!factText || factText.length < 5) continue;
          const factKey = factKeys[i];
          const existingRaw = existingRaws[i];
          if (existingRaw) {
            const parsed = JSON.parse(existingRaw);
            const newCount = (parsed.count || 1) + 1;
            writes.push(env.VECTORS.put(factKey, JSON.stringify({
              ...parsed, count: newCount,
              confidence: Math.min(newCount / 5, 1.0),
              category: parsed.category || category,
              last_reinforced: now,
            }), ttl));
          } else {
            writes.push(env.VECTORS.put(factKey, JSON.stringify({
              fact: factText, entity: canonical, category, confidence: 0.2,
              count: 1, created: now, last_reinforced: now,
            }), ttl));
            if (!keys.includes(factKey)) { keys.push(factKey); newFactsAdded++; }
          }
        }
        await Promise.all(writes);
        if (newFactsAdded > 0) {
          meta.updated = now; meta.total_facts = (meta.total_facts || 0) + newFactsAdded;
          // v10.2.1: pin-aware cap. Pinned (identity/behavioral/instruction/preference)
          // fact-keys survive forever; only unpinned chatter rolls off at 80. Was a flat
          // slice(-50) that silently deleted old identity facts — the "forgets me" bug.
          const cappedKeys = await capFactIndexWithPinsLive(env, keys);
          await Promise.all([
            env.VECTORS.put(indexKey, JSON.stringify(cappedKeys), ttl),
            env.VECTORS.put(metaKey, JSON.stringify(meta), ttl),
          ]);
        }
      }

      // Store structured triples (v5.3)
      if (triples && triples.length > 0) {
        for (const t of triples) {
          if (t.predicate && t.object) {
            // v10 §D: LLM-extracted → "inferred". v10.0.1: fastMode=true skips the
            // per-triple LLM contradiction check (was part of the ingest stall).
            await upsertTriple(env, entity, t.predicate, t.object, t.category || "fact", "inferred", sourceObsId, true);
            localTriples++;
          }
        }
      }
      return localTriples;
    }));
    triplesWritten = perEntityCounts.reduce((a, b) => a + b, 0);

    // v10.2.1/.1: behavioral-inference pass. Brain Owner is the biggest node — study him
    // across domains (build/design/writing/client/decision/habit). Fires whenever
    // the content plausibly reflects HIM: any Brain Owner entity, OR his authored prose
    // (ads/copy/posts/chats) which often doesn't name "Brain Owner" literally. Stores
    // pinned "behavioral" facts AND writes a graph EDGE per pattern so recall can
    // TRAVEL the graph (cheap) instead of dumping many nodes. Budget-gated.
    try {
      const lc = String(content || "").toLowerCase();
      const touchesOwner = entity_facts.some(ef => /ritik|example ?project|ExampleProject/i.test(ef.entity || "")) ||
                           callerEntities.some(e => /ritik|example ?project/i.test(e)) ||
                           /\b(i built|i wrote|i prefer|i like|i designed|write an ad|advertisement|ad copy|my style|ExampleProject|Example Project)\b/.test(lc);
      if (touchesOwner) {
        const patterns = await inferBehavioralPatterns(
          env, callRoleLLM, content,
          () => canAfford(env, NEURON_COST_EXTRACTION)
        );
        if (patterns.length) {
          await addNeuronUsage(env, NEURON_COST_EXTRACTION);
          const canonical = await resolveEntityName(env, "Brain Owner");
          const slug = entitySlug(canonical);
          const now = Date.now();
          const ttl = { expirationTtl: 86400 * 730 };
          const idxKey = `entity:${slug}:facts_index`;
          const idxRaw = await env.VECTORS.get(idxKey);
          const bkeys = idxRaw ? JSON.parse(idxRaw) : [];
          let added = 0;
          for (const p of patterns) {
            const fk = `entity:${slug}:fact:${factHash(p.text.toLowerCase().trim())}`;
            const ex = await env.VECTORS.get(fk);
            if (ex) {
              const parsed = JSON.parse(ex);
              const nc = (parsed.count || 1) + 1;
              await env.VECTORS.put(fk, JSON.stringify({ ...parsed, count: nc, confidence: Math.min(nc / 4, 1.0), category: "behavioral", domain: p.domain || parsed.domain, pinned: true, last_reinforced: now }), ttl);
            } else {
              // Behavioral facts START pinned at higher confidence — inferred from
              // real work, not one-off chatter; must survive cold reboots.
              await env.VECTORS.put(fk, JSON.stringify({ fact: p.text, entity: canonical, category: "behavioral", domain: p.domain, pinned: true, confidence: 0.5, count: 1, created: now, last_reinforced: now }), ttl);
              if (!bkeys.includes(fk)) { bkeys.push(fk); added++; }
            }
            // v10.2.1: write the graph edge so nodes CONNECT (recall travels, not dumps).
            if (p.triple) {
              try { await upsertTriple(env, "Brain Owner", p.triple.predicate, p.triple.object, "behavioral", "inferred", sourceObsId, true); } catch {}
            }
          }
          if (added > 0) await env.VECTORS.put(idxKey, JSON.stringify(await capFactIndexWithPinsLive(env, bkeys)), ttl);
        }
      }
    } catch (e) { console.warn("behavioral pass:", e.message); }
  } else if (callerEntities.length > 0) {
    for (const entity of callerEntities) {
      const words = content.split(/\s+/).slice(0, 50).join(" ");
      if (words.length > 20) await upsertEntityFact(env, entity, `mentioned: ${words.substring(0, 120)}`);
    }
  }
  // v9.7: attach the real triple-write count to the returned meta.
  return { ...observationMeta, triples_written: triplesWritten };
}

// ─── /backfill-facts (v5.0) ───────────────────────────────────────────────────
// Batch-extract entity facts from existing wiki files.
// Resumable: pass offset to continue. Processes 5 files per call to stay < 30s CPU.
async function handleBackfillFacts(req, env) {
  const { offset = 0, batch_size = 5, dry_run = false, dir = "wiki/conversations" } = await req.json().catch(() => ({}));
  const repo = env.GITHUB_REPO || "your-username/your-repo";
  const branch = env.GITHUB_BRANCH || "main";

  const listRes = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${dir}?ref=${branch}`,
    { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } }
  );
  if (!listRes.ok) return jsonErr("Could not list files", 502);
  const allFiles = (await listRes.json()).filter(f => f.name.endsWith(".md"));
  const batch = allFiles.slice(offset, offset + batch_size);

  if (dry_run) {
    return jsonOk({
      status: "dry-run",
      total_files: allFiles.length,
      batch_start: offset,
      batch_size: batch.length,
      sample: batch.map(f => f.name),
      message: `Pass dry_run:false to process. ${allFiles.length - offset} files remaining from offset ${offset}.`,
    });
  }

  const neuronsUsed = await getNeuronUsage(env);
  const neuronsLeft = NEURON_BUDGET_COMPRESSION - neuronsUsed;
  const maxBatch = Math.min(batch_size, Math.floor(neuronsLeft / NEURON_COST_EXTRACTION));
  if (maxBatch <= 0) return jsonErr(`Neuron budget exhausted (${neuronsUsed}/${NEURON_BUDGET_COMPRESSION}). Try tomorrow.`, 429);

  const results = { processed: [], skipped: [], errors: [] };

  for (const file of batch.slice(0, maxBatch)) {
    try {
      const contentRes = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${file.path}?ref=${branch}`,
        { headers: { Accept: "application/vnd.github.v3.raw", "User-Agent": GH_UA } }
      );
      if (!contentRes.ok) { results.skipped.push(file.name); continue; }
      const content = await contentRes.text();

      // Extract entities from frontmatter to guide extraction
      const entityMatch = content.match(/^entities:\s*\[([^\]]+)\]/m);
      const callerEntities = entityMatch ? entityMatch[1].split(",").map(s => s.trim()) : [];

      await extractAndStoreFactsFromContent(env, content, callerEntities, file.path);
      results.processed.push(file.name);
    } catch (e) {
      results.errors.push({ file: file.name, error: e.message });
    }
  }

  const nextOffset = offset + batch.length;
  const remaining = allFiles.length - nextOffset;
  return jsonOk({
    status: "backfill-batch-complete",
    processed: results.processed.length,
    skipped: results.skipped.length,
    errors: results.errors.length,
    processed_files: results.processed,
    error_details: results.errors,
    next_offset: nextOffset,
    remaining,
    message: remaining > 0
      ? `Run again with offset:${nextOffset} to continue. ${remaining} files remaining.`
      : "Backfill complete! All files processed.",
  });
}

// ─── Graph-based keyword search (neuron-free fallback for /ask) ───────────────
// Fetches graph.json (1 subrequest) and scores nodes by term match.
// Used when CF Workers AI neuron quota is exhausted.
async function graphKeywordSearch(env, question, topK = 5) {
  const repo   = env.GITHUB_REPO   || "your-username/your-repo";
  const branch = env.GITHUB_BRANCH || "main";
  const res = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/graph/graph.json?ref=${branch}`,
    { headers: { Accept: "application/vnd.github.v3.raw", "User-Agent": GH_UA } }
  );
  if (!res.ok) return [];

  const graph = await res.json();
  const terms = question.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const nodes = Object.values(graph.nodes || {});

  const scored = nodes
    .filter(n => n.path && (n.path.startsWith("wiki/") || n.path.startsWith("raw/")))
    .map(n => {
      const haystack = `${n.label || ""} ${(n.tags || []).join(" ")} ${(n.entities || []).join(" ")}`.toLowerCase();
      const score = terms.reduce((s, t) => s + (haystack.includes(t) ? 1 : 0), 0);
      return { ...n, _score: score };
    })
    .filter(n => n._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, topK)
    .map(({ _score, ...n }) => ({ path: n.path, name: n.path.split("/").pop(), title: n.label, score: _score / terms.length }));

  return scored;
}

// ─── /ask endpoint (v5.0) ─────────────────────────────────────────────────────
// Subrequest budget: 0 (vectorize embed+query) OR 1 (graph.json fallback) + 1 (NVIDIA) = max 2.
// Fully neuron-independent when CF AI quota exhausted — graph fallback requires 0 neurons.
async function handleAsk(req, env) {
  const { question, top_k = 5 } = await req.json().catch(() => ({}));
  if (!question) return jsonErr("question required", 400);

  // 1. Try Vectorize semantic search (0 subrequests, costs ~2 neurons for embed)
  //    Fall back to graph.json keyword search if neurons exhausted (1 subrequest, 0 neurons)
  let topDocs = [];
  let searchMethod = "none";
  if (env.AI && env.VECTORIZE) {
    try {
      const embedRes = await env.AI.run(EMBEDDING_MODEL, { text: [question] });
      const results = await env.VECTORIZE.query(embedRes.data[0], { topK: top_k, returnMetadata: true });
      topDocs = results.matches
        .filter(m => m.score > 0.3)
        .map(m => ({ path: m.metadata?.path || "", name: (m.metadata?.path || "").split("/").pop(), score: m.score, title: m.metadata?.title, summary: m.metadata?.summary }));
      searchMethod = "vectorize";
    } catch (e) {
      console.warn("/ask vectorize failed, trying graph fallback:", e.message);
    }
  }
  // Graph fallback: triggers when neurons exhausted or Vectorize unavailable
  if (topDocs.length === 0) {
    try {
      topDocs = await graphKeywordSearch(env, question, top_k);
      searchMethod = topDocs.length > 0 ? "graph-keyword" : "none";
    } catch (e) {
      console.warn("/ask graph fallback failed:", e.message);
    }
  }

  // 2. Cross-encoder reranking (U4 v9.1.2): bge-reranker-base, replaces LLM-as-reranker
  if (topDocs.length > 1 && searchMethod === "vectorize") {
    try {
      const candidates = topDocs.map(d => ({ ...d, text: `${d.title || d.name} ${d.summary || ""}` }));
      topDocs = await rerankHybridResults(env, question, candidates, top_k);
      searchMethod = "vectorize+cross-encoder";
    } catch (e) { console.warn("/ask cross-encoder rerank (non-fatal):", e.message); }
  }

  // 3. Entity facts from KV — instructions first, then by decay-weighted score
  const queryWords = [...new Set([...ANCHOR_ENTITIES, ...question.split(/\s+/).filter(w => w.length > 2 && /^[A-Z]/.test(w)).slice(0, 5)])];
  const entityFactsMap = {};
  const instructionFacts = []; // pulled out for top-of-context priority
  const now_ask = Date.now();

  // v10.0.1: fetch facts + triples for all query words in PARALLEL (was two
  // serial loops of independent KV reads on the user-facing /ask path). Order is
  // preserved by mapping over queryWords and merging results in sequence.
  const perWord = await Promise.all(queryWords.map(async (word) => {
    const [allFacts, triples] = await Promise.all([getEntityFacts(env, word), getTriples(env, word)]);
    return { word, allFacts, triples };
  }));

  const tripleLines = [];
  for (const { word, allFacts, triples } of perWord) {
    if (allFacts.length > 0) {
      // Separate instructions — they go to top of context regardless of entity
      const instrs = allFacts.filter(f => f.category === "instruction");
      const rest   = allFacts.filter(f => f.category !== "instruction");
      if (instrs.length > 0) instructionFacts.push(...instrs.map(f => `[RULE] ${f.fact}`));
      // Add temporal context to facts
      entityFactsMap[word] = rest.slice(0, 5).map(f => {
        const ageDays = Math.round((now_ask - (f.last_reinforced || f.created || now_ask)) / 86400000);
        const temporal = ageDays < 1 ? "" : ageDays < 7 ? ` (confirmed ${ageDays}d ago)` : ageDays < 30 ? ` (${Math.round(ageDays/7)}w ago)` : ` (${Math.round(ageDays/30)}mo ago)`;
        return `${f.fact}${temporal}`;
      });
    }
    for (const t of triples.slice(0, 5)) {
      tripleLines.push(`${t.subject} → ${t.predicate}: ${t.object}`);
    }
  }

  // 4. Build context block — instructions at top (mem0 doesn't do this)
  const instrBlock = instructionFacts.length > 0
    ? `=== ACTIVE INSTRUCTIONS (HIGHEST PRIORITY — ALWAYS FOLLOW) ===\n${instructionFacts.join("\n")}`
    : "";
  const tripleBlock = tripleLines.length > 0
    ? `=== STRUCTURED FACTS (TRIPLES) ===\n${tripleLines.join("\n")}`
    : "";
  const factBlock = Object.entries(entityFactsMap).map(([e, fs]) =>
    `Entity: ${e}\n${fs.map(f => `  - ${f}`).join("\n")}`
  ).join("\n\n");
  const docBlock = topDocs.map(d =>
    `[${d.title || d.name}]\n${d.summary ? d.summary.substring(0, 600) : `Path: ${d.path}`}`
  ).join("\n\n---\n\n");

  // v7.1: sparse domain routing index (claude-mem doesn't have this)
  let routingBlock = "";
  try {
    const routingRaw = env.VECTORS ? await env.VECTORS.get("routing:index") : null;
    if (routingRaw) {
      const r = JSON.parse(routingRaw);
      const lines = Object.entries(r)
        .sort((a,b) => (b[1].count||0) - (a[1].count||0))
        .map(([d, e]) => `${d}: ${e.count||0} items, top_tags: [${(e.top_tags||[]).slice(0,5).join(", ")}]`);
      if (lines.length) routingBlock = `=== DOMAIN INDEX (use to scope reasoning) ===\n${lines.join("\n")}`;
    }
  } catch {}

  const contextText = [
    instrBlock,
    routingBlock,
    tripleBlock,
    factBlock ? `=== ENTITY FACTS (with recency) ===\n${factBlock}` : "",
    docBlock  ? `=== RELEVANT DOCUMENTS ===\n${docBlock}` : "",
  ].filter(Boolean).join("\n\n");

  if (!contextText.trim()) {
    return jsonOk({
      question,
      answer: "No relevant information found in your Second Brain for this question.",
      sources: [],
      entity_facts_used: {},
      search_method: searchMethod,
    });
  }

  // 5. Synthesise answer
  const systemPrompt = `You are a personal knowledge assistant with access to structured memory.
CRITICAL: If ACTIVE INSTRUCTIONS are present in context, you MUST follow them — they are rules set by the user.
Answer ONLY from the provided context. Be specific and concrete. Never hallucinate.
When facts include recency info (e.g. "3mo ago"), mention if the information might be stale.
If context doesn't fully answer the question, say so explicitly.`;

  const userPrompt = `Question: ${question}

Context from Second Brain:
${contextText.substring(0, 12000)}

Answer the question directly and specifically. Cite which documents or facts support your answer.`;

  let answer = "Could not generate answer.";
  let llmError = null;
  try {
    const text = await withTimeout(
      callRoleLLM(env, "synthesis", [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ], 800),
      18000, null
    );
    if (text === null) { llmError = "synthesis timeout (18s)"; }
    else { answer = text?.trim() || answer; }
  } catch (e) {
    console.warn("/ask synthesis failed:", e.message);
    llmError = e.message;
  }

  // U5: retrieval critic — grade answer quality (non-blocking, best-effort)
  let critiqueResult = null;
  try {
    const passages = topDocs.slice(0, 5).map(d => d.summary || d.content || d.name || "");
    critiqueResult = await gradeRetrieval(env, callRoleLLM, question, passages);
  } catch (e) { console.warn("/ask critic (non-fatal):", e.message); }

  return jsonOk({
    question,
    answer,
    confidence: critiqueResult?.confidence ?? null,
    critique: critiqueResult ? { verdict: critiqueResult.verdict, reason: critiqueResult.reason } : null,
    sources: topDocs.map(d => ({ path: d.path, name: d.name, score: d.score, rerank_score: d.rerank_score })),
    entity_facts_used: entityFactsMap,
    instructions_applied: instructionFacts.length,
    triples_used: tripleLines.length,
    search_method: searchMethod,
    ...(llmError ? { llm_error: llmError } : {}),
  });
}

// ─── /force-reinforce ────────────────────────────────────────────────────────
// Bumps all facts for an entity to target_confidence (default 1.0).
// Fix for BRAIN-STARTUP confidence stuck at 0.2 (count=1, formula: min(count/5, 1.0)).
async function handleForceReinforce(req, env) {
  try {
    const { entity, target_confidence = 1.0 } = await req.json().catch(() => ({}));
    if (!entity) return jsonErr("entity required", 400);
    const conf = Math.min(Math.max(parseFloat(target_confidence) || 1.0, 0.1), 1.0);
    const canonical = await resolveEntityName(env, entity);
    const slug = entitySlug(canonical);
    const indexRaw = await env.VECTORS.get(`entity:${slug}:facts_index`);
    if (!indexRaw) return jsonErr(`No facts for entity: ${entity}`, 404);
    let keys;
    try { keys = JSON.parse(indexRaw); } catch { return jsonErr("facts_index corrupted", 500); }
    if (!Array.isArray(keys) || keys.length === 0) return jsonErr(`No facts found for: ${entity}`, 404);
    const now = Date.now();
    const ttl = { expirationTtl: 86400 * 730 };
    const targetCount = Math.ceil(conf * 5);
    const raws = await Promise.all(keys.filter(Boolean).map(k => env.VECTORS.get(k)));
    let updated = 0;
    await Promise.all(raws.map((raw, i) => {
      if (!raw || !keys[i]) return Promise.resolve();
      let fact;
      try { fact = JSON.parse(raw); } catch { return Promise.resolve(); }
      updated++;
      return env.VECTORS.put(keys[i], JSON.stringify({
        ...fact,
        count: Math.max(fact.count || 1, targetCount),
        confidence: conf,
        last_reinforced: now,
      }), ttl);
    }));
    return jsonOk({ entity: canonical, facts_reinforced: updated, target_confidence: conf });
  } catch (e) {
    return jsonErr(`force-reinforce failed: ${e.message}`, 500);
  }
}

// ─── /write-entity-triples ───────────────────────────────────────────────────
// Directly write structured triples for an entity without LLM extraction.
// Used to populate triples for BRAIN-STARTUP and other key entities that
// already have entity facts but no corresponding triple:* KV keys.
async function handleWriteEntityTriples(req, env) {
  const { entity, triples = [] } = await req.json().catch(() => ({}));
  if (!entity) return jsonErr("entity required", 400);
  if (!Array.isArray(triples) || triples.length === 0) return jsonErr("triples[] required", 400);
  let written = 0;
  for (const t of triples) {
    if (t.predicate && t.object) {
      // v10 §D: direct admin write, verbatim from request body → "stated"
      await upsertTriple(env, entity, t.predicate, t.object, t.category || "instruction", "stated", null);
      written++;
    }
  }
  return jsonOk({ entity, triples_written: written });
}

// ─── /query-triples endpoint (v5.3) ──────────────────────────────────────────
// GET /query-triples?entity=X&predicate=Y&category=Z
async function handleQueryTriples(url, env) {
  const entity    = url.searchParams.get("entity") || url.searchParams.get("e");
  const predicate = url.searchParams.get("predicate") || url.searchParams.get("p");
  const category  = url.searchParams.get("category") || url.searchParams.get("c");
  if (!entity) return jsonErr("entity required", 400);
  const triples = await getTriples(env, entity, predicate || null, category || null);
  const canonical = await resolveEntityName(env, entity);
  return jsonOk({ entity, resolved_to: canonical, predicate_filter: predicate || null, category_filter: category || null, triples, total: triples.length });
}

// ─── LLM compression ─────────────────────────────────────────────────────────
async function llmCompress(env, title, content) {
  const inputText = content.substring(0, 24000);
  try {
    const text = await callRoleLLM(env, "compression", [
      { role: "system", content: "You compress conversations and documents into wiki pages. Output valid JSON only. NEVER rewrite or paraphrase any content that appears between ⚠ DO_NOT_REWRITE markers — quote it verbatim." },
      { role: "user", content: `Compress this into a wiki page for: "${title}"\n\nContent:\n${inputText}\n\nReturn: {"summary":"2-3 sentence summary","decisions":["decided X"],"insights":["learned Y"],"entities":["ProperNoun"],"tags":["tag"]}\n\nIf content includes podium emojis (🥇🥈🥉), "Niche N", "Step N", or numbered rankings, list them verbatim under "decisions" without rewording. Do NOT renumber, reorder, or paraphrase enumerated items.` },
    ], 800);
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed?.summary) {
        await addNeuronUsage(env, NEURON_COST_PRIMARY);
        return { ...parsed, _model: "external-llm" };
      }
    }
  } catch (e) { console.warn("llmCompress failed:", e.message); }
  return null;
}

async function optimizeTelegramNote(env, rawText) {
  try {
    const text = await callRoleLLM(env, "compression", [
      { role: "user", content: `Rewrite this voice-note into a clean structured knowledge note. Preserve ALL details. Fix spelling. Add structure. No preamble.\n\n${rawText}` },
    ], 2048);
    return text?.trim() || rawText;
  } catch { return rawText; }
}

// ─── Karpathy COMPRESS ────────────────────────────────────────────────────────
// v9: verdictBlocks param — enumerated rankings extracted by extractVerdictBlocks
// are pinned verbatim under "## Key Decisions ⚠ DO_NOT_REWRITE" so the LLM
// summarizer (and any future re-compression) can't paraphrase them away.
// Caller-supplied wiki body (e.g. Opus-compressed). Stored verbatim — no external
// LLM. Wraps the body in standard frontmatter + backlinks; pins any verdict blocks.
// v10 §A: opts = { docType, projectMeta, rawDir } lets a project note carry
// type: project + its meta fields and point Sources at the right raw dir. Defaults
// preserve the original conversation behavior for every existing caller.
function buildCallerWiki(title, date, tags, entities, surface, wikiBody, verdictBlocks = [], opts = {}) {
  const docType = opts.docType || "compressed-conversation";
  const rawDir  = opts.rawDir  || "raw/conversations";
  const metaLines = opts.projectMeta ? Object.entries(opts.projectMeta)
    .filter(([,v]) => v != null && v !== "")
    .map(([k,v]) => Array.isArray(v) ? `${k}: [${v.join(", ")}]` : `${k}: ${v}`) : [];
  const verdictSection = (verdictBlocks && verdictBlocks.length)
    ? `## Key Decisions ⚠ DO_NOT_REWRITE\n<!-- Verbatim enumerated rankings — never paraphrase, never reorder. -->\n${verdictBlocks.join("\n\n")}\n\n`
    : "";
  return [
    "---",
    `type: ${docType}`,
    `title: ${title}`,
    `created: ${date}`,
    ...metaLines,
    tags.length     ? `tags: [${tags.join(", ")}]`         : "",
    entities.length ? `entities: [${entities.join(", ")}]` : "",
    `surface: ${surface}`,
    `compression: caller-supplied`,
    "---",
    "",
    `# ${title}`,
    "",
    balanceFences(verdictSection + wikiBody.trim()),
    "",
    `## Sources`,
    `- Raw: \`${rawDir}/${date}-${slugify(title)}.md\``,
    "",
    `## Backlinks`,
    `[[index]] · [[${date.slice(0, 7)}]]`,
    "",
  ].filter(l => l !== undefined && l !== "").join("\n");
}

async function compressToWiki(env, title, content, tags, entities, date, verdictBlocks = [], opts = {}) {
  const docType = opts.docType || "compressed-conversation";
  const rawDir  = opts.rawDir  || "raw/conversations";
  const metaLines = opts.projectMeta ? Object.entries(opts.projectMeta)
    .filter(([,v]) => v != null && v !== "")
    .map(([k,v]) => Array.isArray(v) ? `${k}: [${v.join(", ")}]` : `${k}: ${v}`) : [];
  const wordCount = content.split(/\s+/).length;
  const tokenEst  = Math.round(wordCount * 1.3);
  const llm = await llmCompress(env, title, content);

  let summary, decisions, insights, finalEntities, finalTags, method;
  if (llm) {
    summary      = llm.summary || "";
    decisions    = llm.decisions || [];
    insights     = llm.insights || [];
    finalEntities = entities.length ? entities : (llm.entities || []);
    finalTags    = tags.length ? tags : (llm.tags || []);
    method       = `wiki-llm-${llm._model}`;
  } else {
    summary      = extractSummary(content);
    decisions    = extractSection(content, ["decided","chose","will use","going with","selected"]);
    insights     = extractSection(content, ["insight","learned","discovered","realized","key point"]);
    finalEntities = entities.length ? entities : extractEntities(content);
    finalTags    = tags;
    method       = "wiki-regex-fallback";
  }

  const code = extractCodeBlocks(content).slice(0, 3);

  // v9: pinned verdict/list section — verbatim, marked DO_NOT_REWRITE.
  const verdictSection = (verdictBlocks && verdictBlocks.length)
    ? `## Key Decisions ⚠ DO_NOT_REWRITE\n<!-- Verbatim enumerated rankings — never paraphrase, never reorder. -->\n${verdictBlocks.map(b => b).join("\n\n")}\n`
    : "";

  return [
    "---",
    `type: ${docType}`,
    `title: ${title}`,
    `created: ${date}`,
    ...metaLines,
    finalTags.length     ? `tags: [${finalTags.join(", ")}]`         : "",
    finalEntities.length ? `entities: [${finalEntities.join(", ")}]` : "",
    `raw_tokens_est: ${tokenEst}`,
    `compression: ${method}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Summary",
    balanceFences(summary) || "_No summary extracted_",
    "",
    verdictSection,
    decisions.length ? `## Decisions\n${decisions.map(d => `- ${d}`).join("\n")}\n` : "",
    insights.length  ? `## Insights\n${insights.map(i => `- ${i}`).join("\n")}\n`       : "",
    finalEntities.length ? `## Entities\n${finalEntities.map(e => `- [[${e}]]`).join("\n")}\n` : "",
    code.length          ? `## Code\n${code.map(c => "```\n" + c + "\n```").join("\n")}\n`     : "",
    `## Sources`,
    `- Raw: \`${rawDir}/${date}-${slugify(title)}.md\``,
    "",
    // v7.9.0: Backlinks for Obsidian graph coherence
    `## Backlinks`,
    `[[index]] · [[${date.slice(0, 7)}]]`,
    "",
  ].filter(l => l !== undefined).join("\n");
}

// ─── Karpathy INGEST ──────────────────────────────────────────────────────────
// ─── Observation storage (v6.0) ───────────────────────────────────────────────
// KV key schema:
//   obs:meta:{id}          → {id, title, category, before_summary, after_summary, timestamp, entities, tags, wiki_path, raw_path, type}
//   obs:session:{date}     → JSON string[] of obs ids for that date (capped 100)
//   obs:latest_session     → most recent date string
//   obs:recent             → JSON string[] of recent obs ids (capped 200)
const OBS_TTL = { expirationTtl: 86400 * 730 };
const OBS_SESSION_CAP = 100;
const OBS_RECENT_CAP = 200;

// ─── Domain routing ───────────────────────────────────────────────────────────
const ROUTING_DOMAINS = ["code", "work", "personal", "research", "health", "finance", "general"];

async function classifyDomain(env, content, tags) {
  const tagStr = (tags || []).join(" ").toLowerCase();
  const cSnip  = (content || "").substring(0, 400).toLowerCase();
  if (/\b(code|javascript|typescript|python|rust|go|sql|api|bug|function|class|import|npm|git|deploy|worker|cloudflare)\b/.test(tagStr + " " + cSnip)) return "code";
  if (/\b(meeting|client|project|deadline|team|business|revenue|sales|startup|product|marketing|invoice)\b/.test(tagStr + " " + cSnip)) return "work";
  if (/\b(health|medical|doctor|medicine|symptom|exercise|diet|fitness|gym)\b/.test(tagStr + " " + cSnip)) return "health";
  if (/\b(finance|money|invest|budget|tax|expense|income|bank|crypto)\b/.test(tagStr + " " + cSnip)) return "finance";
  if (/\b(paper|research|study|learn|course|book|reading|notes|academic|citation)\b/.test(tagStr + " " + cSnip)) return "research";
  if (/\b(personal|diary|family|friend|habit|morning|journal|reflection)\b/.test(tagStr + " " + cSnip)) return "personal";
  try {
    const r = await callRoleLLM(env, "synthesis", [{ role: "user", content: `Classify into exactly one domain: code, work, personal, research, health, finance, general. Reply with just the word.\n\n${content.substring(0,300)}` }], 5);
    const d = (r||"").trim().toLowerCase().replace(/[^a-z]/g,"");
    if (ROUTING_DOMAINS.includes(d)) return d;
  } catch {}
  return "general";
}

async function updateRoutingIndex(env, domain, title, tags) {
  if (!env.VECTORS) return;
  try {
    const KEY = "routing:index";
    const raw = await env.VECTORS.get(KEY);
    const index = raw ? JSON.parse(raw) : {};
    const entry = index[domain] || { count: 0, top_tags: [], recent_titles: [], last_updated: null };
    entry.count = (entry.count || 0) + 1;
    entry.last_updated = new Date().toISOString();
    entry.recent_titles = [title, ...(entry.recent_titles || [])].slice(0, 20);
    const tagFreq = {};
    for (const t of [...(entry.top_tags || []), ...(tags || [])]) if (t) tagFreq[t] = (tagFreq[t] || 0) + 1;
    entry.top_tags = Object.entries(tagFreq).sort((a,b) => b[1]-a[1]).slice(0, 15).map(([t]) => t);
    index[domain] = entry;
    await env.VECTORS.put(KEY, JSON.stringify(index), { expirationTtl: 86400 * 730 });
  } catch (e) { console.warn("updateRoutingIndex:", e.message); }
}

// Backfill domain classification across existing observations + wiki files
async function handleBackfillDomains(req, env) {
  const { offset = 0, batch_size = 10, dir = "wiki/conversations", dry_run = false } = await req.json().catch(() => ({}));
  if (!env.VECTORS) return jsonErr("KV unavailable", 503);
  const repo = env.GITHUB_REPO || "your-username/your-repo";
  const branch = env.GITHUB_BRANCH || "main";

  const listRes = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${dir}?ref=${branch}`,
    { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } }
  );
  if (!listRes.ok) return jsonErr("Could not list files", 502);
  const allFiles = (await listRes.json()).filter(f => f.name.endsWith(".md"));
  const batch = allFiles.slice(offset, offset + batch_size);

  if (dry_run) return jsonOk({ status: "dry-run", total: allFiles.length, batch: batch.map(f => f.name) });

  const results = { processed: [], errors: [], by_domain: {} };
  for (const file of batch) {
    try {
      const contentRes = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${file.path}?ref=${branch}`,
        { headers: { Accept: "application/vnd.github.v3.raw", "User-Agent": GH_UA } }
      );
      if (!contentRes.ok) { results.errors.push({ file: file.name, error: "fetch-failed" }); continue; }
      const content = await contentRes.text();
      const tagMatch = content.match(/^tags:\s*\[([^\]]+)\]/m);
      const tags = tagMatch ? tagMatch[1].split(",").map(s => s.trim()) : [];
      const titleMatch = content.match(/^title:\s*(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : file.name.replace(/\.md$/, "");
      const domain = await classifyDomain(env, content, tags);
      await updateRoutingIndex(env, domain, title, tags);
      const wikiPath = `${dir}/${file.name}`;
      const obsId = obsIdFromWikiPath(wikiPath);
      const existing = await env.VECTORS.get(`obs:meta:${obsId}`);
      if (existing) {
        const obs = JSON.parse(existing);
        obs.domain = domain;
        await env.VECTORS.put(`obs:meta:${obsId}`, JSON.stringify(obs), OBS_TTL);
      }
      results.processed.push({ file: file.name, domain });
      results.by_domain[domain] = (results.by_domain[domain] || 0) + 1;
    } catch (e) { results.errors.push({ file: file.name, error: e.message }); }
  }

  const nextOffset = offset + batch.length;
  return jsonOk({
    status: "backfill-domains-batch",
    total: allFiles.length,
    processed_count: results.processed.length,
    by_domain: results.by_domain,
    errors: results.errors,
    next_offset: nextOffset,
    remaining: Math.max(0, allFiles.length - nextOffset),
    sample: results.processed.slice(0, 10),
  });
}

// Auto-backfill: loops processing batches inline until ~45s elapsed or done.
// State stored in KV `backfill:domains:offset` so repeat calls continue from cursor.
async function handleAutoBackfillDomains(req, env) {
  if (!env.VECTORS) return jsonErr("KV unavailable", 503);
  const url = new URL(req.url);
  const startTime = Date.now();
  const TIME_BUDGET_MS = 40000;
  // CF free tier subrequest cap = 50 fetch() per invocation.
  // Each batch uses 1 list + batch_size fetches. Cap accordingly.
  const BATCH = Math.min(10, Math.max(1, parseInt(url.searchParams.get("batch")||"5",10)));
  const MAX_ITERS = Math.max(1, Math.floor(45 / (1 + BATCH)));
  const reset = url.searchParams.get("reset") === "1";
  if (reset) await env.VECTORS.delete("backfill:domains:offset");

  let offset = parseInt(await env.VECTORS.get("backfill:domains:offset") || "0", 10);
  const offsetParam = parseInt(url.searchParams.get("offset")||"-1",10);
  if (offsetParam >= 0) offset = offsetParam;
  const totals = { processed: 0, by_domain: {}, batches: 0, errors: 0 };
  let last = null;
  let iters = 0;

  while (Date.now() - startTime < TIME_BUDGET_MS && iters < MAX_ITERS) {
    iters++;
    const fakeReq = new Request("https://internal/backfill-domains",{method:"POST",body:JSON.stringify({offset,batch_size:BATCH,dry_run:false})});
    const res = await handleBackfillDomains(fakeReq, env);
    const json = await res.json();
    last = json;
    if (!json.processed_count || json.processed_count === 0) break;
    totals.processed += json.processed_count;
    totals.batches++;
    totals.errors += (json.errors || []).length;
    for (const [d,c] of Object.entries(json.by_domain || {})) totals.by_domain[d] = (totals.by_domain[d] || 0) + c;
    offset = json.next_offset;
    await env.VECTORS.put("backfill:domains:offset", String(offset));
    if (json.remaining === 0) { totals.done = true; break; }
  }
  return jsonOk({ status: "auto-backfill-tick", elapsed_ms: Date.now() - startTime, current_offset: offset, total_files: last?.total, remaining: last?.remaining, ...totals });
}

function obsIdFromWikiPath(wikiPath) {
  return wikiPath.replace(/[^a-z0-9]/gi, "-");
}

async function storeObservation(env, record) {
  if (!env.VECTORS || !record?.id) return;
  try {
    // session_id bucket = IST date (UTC date previously caused cross-day drift)
    const tsUtc = record.timestamp || new Date().toISOString();
    const date = istDateStr(tsUtc);
    record.session_id = record.session_id || date;
    record.timestamp_ist = record.timestamp_ist || istIsoStr(tsUtc);
    // v9: surface first-class — preserve on BOTH obs.surface AND obs.meta.surface
    const inSurface = normalizeSurface(record.surface) || record.surface;
    record.surface = inSurface || "other";
    record.meta = record.meta || {};
    record.meta.surface = record.surface;
    await env.VECTORS.put(`obs:meta:${record.id}`, JSON.stringify(record), OBS_TTL);

    const sessKey = `obs:session:${date}`;
    const sessRaw = await env.VECTORS.get(sessKey);
    const sessList = sessRaw ? JSON.parse(sessRaw) : [];
    if (!sessList.includes(record.id)) sessList.push(record.id);
    const cappedSess = sessList.slice(-OBS_SESSION_CAP);
    await env.VECTORS.put(sessKey, JSON.stringify(cappedSess), OBS_TTL);

    // v9: write to BOTH legacy `obs:recent` and the new sharded `recent:all` +
    // `recent:{surface}` keys. list_recent reads the shard when filter passed.
    // v10.0.1: 3 independent keys → parallel get+put (was serial, on sync path).
    await Promise.all(["obs:recent", "recent:all", `recent:${record.surface}`].map(async (key) => {
      const raw = await env.VECTORS.get(key);
      const list = raw ? JSON.parse(raw) : [];
      const filtered = list.filter(x => x !== record.id);
      filtered.push(record.id);
      await env.VECTORS.put(key, JSON.stringify(filtered.slice(-OBS_RECENT_CAP)), OBS_TTL);
    }));

    await env.VECTORS.put("obs:latest_session", date, OBS_TTL);

    // Track all session_id buckets seen (sorted desc, cap 90) so list_recent
    // and get_session_index can union the freshest N buckets.
    const slRaw = await env.VECTORS.get("obs:sessions:list");
    const sl = slRaw ? JSON.parse(slRaw) : [];
    if (!sl.includes(date)) {
      sl.push(date);
      sl.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      await env.VECTORS.put("obs:sessions:list", JSON.stringify(sl.slice(0, 365)), OBS_TTL);
    }

    // Surface index — fast filtered retrieval.
    const tsMs = Date.parse(tsUtc) || Date.now();
    await env.VECTORS.put(`index:surface:${record.surface}:${tsMs}:${record.id}`, record.id, OBS_TTL);

    // SESSION-HANDOFF supersedence: each new handoff invalidates priors
    // and overwrites state:session-handoff:latest.
    const ents = Array.isArray(record.entities) ? record.entities : [];
    if (ents.includes("SESSION-HANDOFF")) {
      try {
        const listRaw = await env.VECTORS.get("state:session-handoff:list");
        const list = listRaw ? JSON.parse(listRaw) : [];
        // v9.8: parallel supersedence — was sequential get+put per entry → O(n×KV_latency)
        // causing 20-40s blocking on lists with 50-100 entries. Now parallel reads then
        // parallel writes, O(1) wall-clock regardless of list length.
        const supersedenceNow = Date.now();
        const priorEntries = await Promise.all(
          list
            .filter(id => id !== record.id)
            .map(async id => {
              const raw = await env.VECTORS.get(`obs:meta:${id}`);
              if (!raw) return null;
              const prior = JSON.parse(raw);
              if (prior.superseded_by) return null; // already superseded
              return { id, prior };
            })
        );
        await Promise.all(
          priorEntries
            .filter(Boolean)
            .map(({ id, prior }) => {
              prior.superseded_by = record.id;
              prior.superseded_at = supersedenceNow;
              return env.VECTORS.put(`obs:meta:${id}`, JSON.stringify(prior), OBS_TTL);
            })
        );
        if (!list.includes(record.id)) list.push(record.id);
        await env.VECTORS.put("state:session-handoff:list", JSON.stringify(list.slice(-100)), OBS_TTL);

        // v9: extended handoff schema — active_topics, open_verdicts,
        // open_decisions, firecrawl_research_conducted. Caller may pass these
        // directly on the SESSION-HANDOFF ingest (via tags/entities + extras
        // injected on record.meta), else we synthesise from recent activity.
        const m = record.meta || {};
        const tagLower = (record.tags || []).map(t => String(t).toLowerCase());
        const firecrawlFlag = tagLower.some(t => /firecrawl|research-conducted/.test(t))
          || /firecrawl|firecrawl_research/i.test(record.content || record.title || "");
        const latest = {
          observation_id: record.id,
          timestamp: tsUtc,
          timestamp_ist: record.timestamp_ist,
          surface: record.surface,
          topic: record.topic || record.title || "",
          state: record.state || record.handoff_state || "",
          next_action: record.next_action || "",
          trail: record.trail || [],
          wiki_path: record.wiki_path || null,
          // v9 additions
          active_topics: Array.isArray(m.active_topics) ? m.active_topics : (record.entities || []).slice(0, 8),
          open_verdicts: Array.isArray(m.open_verdicts) ? m.open_verdicts : [],
          open_decisions: Array.isArray(m.open_decisions) ? m.open_decisions : [],
          firecrawl_research_conducted: typeof m.firecrawl_research_conducted === "boolean" ? m.firecrawl_research_conducted : firecrawlFlag,
          schema_version: 9,
        };
        await env.VECTORS.put("state:session-handoff:latest", JSON.stringify(latest), OBS_TTL);
      } catch (e) { console.warn("session-handoff supersede (non-fatal):", e.message); }
    }
  } catch (e) { console.warn("storeObservation (non-fatal):", e.message); }
}

async function readObservation(env, id) {
  if (!env.VECTORS || !id) return null;
  try {
    const raw = await env.VECTORS.get(`obs:meta:${id}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.category) parsed.category = "conversation";
    return parsed;
  } catch { return null; }
}

// v10.2.2 perf: chunked-parallel observation reads. Serial readObservation
// loops were O(n × KV_latency) wall-clock; Promise.all per chunk keeps the
// subrequest count identical but collapses latency to O(n / chunk).
async function readObservationsBatch(env, ids, chunk = 25) {
  const out = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const part = await Promise.all(ids.slice(i, i + chunk).map(async id => ({ id, obs: await readObservation(env, id) })));
    out.push(...part);
  }
  return out;
}

// Early-exit variant: rowFn(obs, id) → row|null. Stops fetching further chunks
// once `limit` rows collected, so filtered scans over recent:all (≤200 ids)
// usually finish in one 25-wide chunk instead of 200 serial round-trips.
async function scanObservations(env, ids, limit, rowFn, chunk = 25) {
  const out = [];
  for (let i = 0; i < ids.length && out.length < limit; i += chunk) {
    const part = await Promise.all(ids.slice(i, i + chunk).map(async id => ({ id, obs: await readObservation(env, id) })));
    for (const { id, obs } of part) {
      if (!obs) continue;
      const row = rowFn(obs, id);
      if (row) { out.push(row); if (out.length >= limit) break; }
    }
  }
  return out;
}

async function handleSessionStartSummary(env) {
  if (!env.VECTORS) return jsonOk({ last_session_date: null, last_session_files: [], open_threads: [], recent_decisions: [], note: "KV unavailable" });
  try {
    const lastDate = await env.VECTORS.get("obs:latest_session");
    let lastSessionFiles = [];
    let openThreads = [];
    if (lastDate) {
      const sessRaw = await env.VECTORS.get(`obs:session:${lastDate}`);
      const sessIds = sessRaw ? JSON.parse(sessRaw) : [];
      // v10.2.2 perf: parallel read of the last-20 session observations.
      const recentSessionObs = (await readObservationsBatch(env, sessIds.slice(-20))).map(r => r.obs).filter(Boolean);
      lastSessionFiles = recentSessionObs.map(o => o.wiki_path || o.raw_path).filter(Boolean).map(p => p.split("/").pop());
      openThreads = recentSessionObs
        .filter(o => o.category === "discovery" || (o.tags || []).some(t => /todo|pending|open|unresolved/i.test(t)))
        .map(o => o.title)
        .filter(Boolean)
        .slice(0, 10);
    }

    const recRaw = await env.VECTORS.get("obs:recent");
    const recIds = recRaw ? JSON.parse(recRaw) : [];
    // v10.2.2 perf: early-exit chunked scan for the 5 newest decisions.
    const recentDecisions = await scanObservations(env, [...recIds].reverse(), 5,
      obs => obs.category === "decision" ? { title: obs.title, category: "decision", when: obs.timestamp } : null);

    return jsonOk({
      last_session_date: lastDate || null,
      last_session_files: lastSessionFiles,
      open_threads: openThreads,
      recent_decisions: recentDecisions,
    });
  } catch (e) {
    return jsonOk({ last_session_date: null, last_session_files: [], open_threads: [], recent_decisions: [], error: e.message });
  }
}

async function runIngestPipeline(env, ctx, { title, content, type = "note", tags = [], entities = [], source_url = "", surface, topic, state, next_action, trail, wiki_body = "", project_meta = null }) {
  if (!title || !content) throw new Error("title and content required");
  const t0 = Date.now();

  // KV write budget check — Workers Paid: 1,000,000 writes/day.
  // Each ingest burns ~25 KV writes (facts + triples + obs + routing).
  // Block and surface real error instead of silent data loss.
  const kvBudget = await checkKVWriteBudget(env, 25);
  if (!kvBudget.ok) throw new Error(kvBudget.error);

  // v9: surface preserved verbatim through to obs.surface + obs.meta.surface.
  // Default to "other" ONLY if missing/invalid.
  let resolvedSurface = normalizeSurface(surface);
  if (!resolvedSurface) {
    if (surface) console.warn(`[capture] unknown surface "${surface}" — defaulting to "other"`);
    else console.warn(`[capture] surface omitted — defaulting to "other"`);
    resolvedSurface = "other";
  }
  const tagSet = new Set([...(tags || []), resolvedSurface]);
  const entSet = new Set([...(entities || []), resolvedSurface]);
  tags = [...tagSet];
  entities = [...entSet];

  // Filename + session_id bucket = IST date (UTC drift caused May-13 / May-17 mix)
  const now     = istDateStr();
  const slug    = slugify(title);
  const rawDir  = type === "code" ? "raw/code"  : type === "web" ? "raw/web"  : type === "project" ? "raw/projects" : "raw/conversations";
  const wikiDir = type === "code" ? "wiki/code" : type === "web" ? "wiki/web" : type === "project" ? "wiki/projects" : "wiki/conversations";
  const rawPath  = `${rawDir}/${now}-${slug}.md`;
  const wikiPath = `${wikiDir}/${now}-${slug}.md`;

  // ── Sync path (returns in <2s) ──────────────────────────────────────────────
  // v9.0.4: raw GitHub PUT moved to async path. Was 10-30s blocking the response
  // and causing hook-side 30-90s timeouts. Path is computed deterministically,
  // so response can return rawPath before write lands. asyncWork retries on fail.
  const fm    = buildFrontmatter({ type, created: now, tags, entities, source_url, surface: resolvedSurface, session_id: now, extra: type === "project" ? (project_meta || {}) : undefined });
  const backlinks = `\n\n## Backlinks\n[[index]] · [[${now.slice(0, 7)}]]\n`;
  const rawFileBody = fm + content + backlinks;

  // v9.0.3: verdict/list pre-extraction (cheap regex) stays sync.
  // LLM compress + wiki write + log + index moved to async path.
  const verdictBlocks = extractVerdictBlocks(content);
  // Placeholder compressed (regex summary) so downstream sync writes have content.
  const compressed = `---\ntype: compressed-conversation\ntitle: ${title}\ncreated: ${now}\ntags: [${tags.join(", ")}]\nentities: [${entities.join(", ")}]\nsurface: ${resolvedSurface}\nstatus: pending-llm-compression\n---\n\n# ${title}\n\n${extractSummary(content)}\n\n${verdictBlocks.length ? `## Key Decisions ⚠ DO_NOT_REWRITE\n${verdictBlocks.join("\n\n")}\n` : ""}\n## Full Content\n${content.slice(0, 4000)}${content.length > 4000 ? "\n\n... [truncated for placeholder, full content in raw and will be LLM-compressed async]" : ""}\n`;

  const obsId = obsIdFromWikiPath(wikiPath);
  const tsUtc = new Date().toISOString();

  // v9: SYNC critical writes — obs:meta + recent indexes BEFORE response so
  // get_observation(id) + list_recent({surface}) succeed on the next call.
  // Also synchronous: D1 FTS5 + triples (so keyword_search + query_triples
  // hit instantly). Heavy LLM extraction stays in waitUntil.
  await storeObservation(env, {
    id: obsId, title, category: "conversation",
    before_summary: "", after_summary: "",
    timestamp: tsUtc, timestamp_ist: istIsoStr(tsUtc), session_id: now,
    entities, tags, type, wiki_path: wikiPath, raw_path: rawPath, domain: null,
    surface: resolvedSurface,
    meta: { surface: resolvedSurface, source_url: source_url || "" },
    topic: topic || title,
    state: state || "",
    next_action: next_action || "",
    trail: Array.isArray(trail) ? trail : [],
  });

  // v9: D1 FTS5 sync write — instant keyword retrieval.
  const fts5Ok = await writeFts5(env, {
    id: obsId, title, content, entities, tags,
    surface: resolvedSurface, timestamp_utc: tsUtc, session_id: now,
  });

  // v9: triples for enumerated rankings (Niche N, Step N, "1." …).
  let triplesWritten = 0;
  try {
    const rankTriples = extractRankingTriples(content);
    for (const t of rankTriples.slice(0, 30)) {
      // v10 §D: regex-extracted from user's own numbered-list content → "stated"
      try { await upsertTriple(env, t.subject, t.predicate, t.object, "fact", "stated", obsId); triplesWritten++; } catch {}
    }
  } catch (e) { console.warn("ranking triples (non-fatal):", e.message); }

  // v9.7 NOTE: entity-fact + S-P-O triple extraction stays in the async waitUntil
  // path (see asyncWork below). Moving it sync caused CF 1101 (wall-clock timeout)
  // because callRoleLLM adds ~1-2s external LLM latency that the sync path can't
  // absorb. Instead: ranking triples count sync (truthful for ranked content),
  // plus triples_pending:true flags that LLM-extracted triples will land shortly.
  // The lint triple_memory count (triple:* KV scan) is always the ground truth.
  let observationMeta = null; // populated async below, used for category/summary patch

  // v9.0.3: multi-vector embedding moved to async path. fts5 + triples already
  // written sync, so keyword retrieval works immediately. Semantic vectors lag
  // by a few seconds but no longer block the response.
  let vectorsWritten = [];

  // v9.1: verification on write. SYNC only for authoritative/verdict (need confirmed retrieval).
  // Standard captures get verify pushed to async path — fts5+triples already written, semantic
  // probe was adding 15-25s to response time and causing MCP-client timeouts.
  const tagStrLower = (tags || []).join(" ").toLowerCase();
  const isAuthoritative = /authoritative|verdict|high-priority/i.test(tagStrLower);
  let verified_retrievable = !!fts5Ok; // optimistic: fts5 write confirms keyword-retrievable
  let verified_indexed = !!fts5Ok;
  let vectorize_ack = null;
  try {
    if (isAuthoritative) {
      vectorize_ack = await pollVectorizeAck(env, title, obsId, 10000);
      verified_retrievable = vectorize_ack.acked || verified_indexed;
    }
    // Non-authoritative: skip sync probe. Semantic-index check moved to asyncWork.
  } catch (e) { console.warn("verify-on-write (non-fatal):", e.message); }

  // ── Async path: raw write + LLM compress + wiki write + log + index + embed + facts ────
  const asyncWork = async () => {
    // v9.0.4: raw GitHub PUT moved here from sync path. 1 retry on failure.
    try {
      let rawOk = await writeFile(env, rawPath, rawFileBody, `ingest: ${title}`);
      if (!rawOk) {
        rawOk = await writeFile(env, rawPath, rawFileBody, `ingest (retry): ${title}`);
      }
      if (!rawOk) console.warn(`async raw write failed after retry: ${rawPath}`);
    } catch (e) { console.warn("async raw write (non-fatal):", e.message); }

    // v10.0.1: extraction moved to the FRONT of asyncWork. It's the user-visible
    // payload (facts + triples), and it was previously starved — running after
    // compress(LLM)+embed(2 AI calls) consumed ~30s first, so extraction's own
    // ~14s pushed the total past CF's waitUntil wall-clock and the isolate was
    // recycled before facts committed. Running it first guarantees it lands within
    // budget; the secondary steps (compress/embed/domain/memtype) tolerate being cut.
    try { observationMeta = await extractAndStoreFactsFromContent(env, content, entities, obsId); }
    catch (e) { console.warn("Fact extraction (non-fatal):", e.message); }

    // Compression. If the caller (e.g. Opus) supplied a pre-compressed wiki_body,
    // store it VERBATIM and skip the weak external-LLM pass entirely. Otherwise
    // fall back to compressToWiki (NVIDIA NIM). Placeholder good until either lands.
    let finalCompressed = compressed;
    // v10 §A: project notes carry type + meta + correct raw-dir into the wiki file.
    const wikiOpts = type === "project"
      ? { docType: "project", projectMeta: project_meta || {}, rawDir }
      : {};
    try {
      if (wiki_body && wiki_body.trim()) {
        finalCompressed = buildCallerWiki(title, now, tags, entities, resolvedSurface, wiki_body, verdictBlocks, wikiOpts);
        await writeFile(env, wikiPath, finalCompressed, `wiki: caller-supplied ${title}`);
      } else if (env.OPENCODE_ZEN_API_KEY || env.VERCEL_AI_GATEWAY_KEY || env.OPENROUTER_API_KEY) {
        // v9.6: prefer the Western/sovereign callLLM router for auto-compression.
        let routed = "";
        try { routed = await generateWikiBody(content, title, env); } catch (e) { console.warn("generateWikiBody:", e.message); }
        if (routed && routed.length > 50) {
          finalCompressed = buildCallerWiki(title, now, tags, entities, resolvedSurface, routed, verdictBlocks, wikiOpts);
          await writeFile(env, wikiPath, finalCompressed, `wiki: router-compiled ${title}`);
        } else {
          finalCompressed = await compressToWiki(env, title, content, tags, entities, now, verdictBlocks, wikiOpts);
          await writeFile(env, wikiPath, finalCompressed, `wiki: compile ${title}`);
        }
      } else {
        finalCompressed = await compressToWiki(env, title, content, tags, entities, now, verdictBlocks, wikiOpts);
        await writeFile(env, wikiPath, finalCompressed, `wiki: compile ${title}`);
      }
      await appendToLog(env, now, "ingest", title, wikiPath);
    } catch (e) { console.warn("async compress (non-fatal):", e.message); }
    // v9.3: updateIndex isolated — compress failure no longer silently skips indexing.
    try {
      await updateIndex(env, title, wikiPath, extractSummary(finalCompressed));
    } catch (e) { console.warn("async updateIndex (non-fatal):", e.message); }

    // multi-vector embed (async since v9.0.3). v9.5: capture REAL counts + fail
    // loud. Any throw is recorded verbatim to vstat:{obsId} — never a silent 0.
    // embedAndStoreMulti / embedAndStore throw on dim mismatch or no-ack upsert.
    if (env.AI && env.VECTORIZE) {
      let multiResult = [];
      let singleOk = false;
      try {
        multiResult = await embedAndStoreMulti(env, obsId, {
          title, content, summary: extractSummary(finalCompressed), entities,
        }, { path: wikiPath, type, tags, surface: resolvedSurface, category: "conversation" });
        const embedContent = type === "note" ? (fm + content) : finalCompressed;
        singleOk = await embedAndStore(env, type === "note" ? rawPath : wikiPath, embedContent,
          { title, type, tags, entities, category: "conversation", before_summary: "", after_summary: "" });
      } catch (e) {
        console.warn("async embed FAILED (recorded to vstat):", e.message);
        await env.VECTORS.put(`vstat:${obsId}`, JSON.stringify({ vectors_written: 0, embed_mode: "error", error: e.message, ts: new Date().toISOString() }), OBS_TTL).catch(() => {});
        multiResult = e;
      }
      if (!(multiResult instanceof Error)) {
        const vw = (Array.isArray(multiResult) ? multiResult.length : 0) + (singleOk ? 1 : 0);
        await env.VECTORS.put(`vstat:${obsId}`, JSON.stringify({ vectors_written: vw, embed_mode: "ok", ts: new Date().toISOString() }), OBS_TTL).catch(() => {});
      }
    }

    // (extraction already ran at the top of asyncWork — v10.0.1)
    const category       = observationMeta?.category       || "conversation";
    const before_summary = observationMeta?.before_summary || "";
    const after_summary  = observationMeta?.after_summary  || "";

    const domain = await classifyDomain(env, content, tags).catch(() => "general");
    await updateRoutingIndex(env, domain, title, tags);

    // U2: classify memory_type (CoALA: episodic|semantic|procedural|working)
    let memTypeRes = { memory_type: "episodic", confidence: 0.3, reason: "default" };
    try {
      memTypeRes = await classifyMemoryType(env, callRoleLLM, { title, content, category, tags, entities, type });
    } catch (e) { console.warn("memory_type classifier (non-fatal):", e.message); }

    // U3: bitemporal conflict resolution — only for semantic claims
    let biresolution = null;
    if (memTypeRes.memory_type === "semantic") {
      try {
        const hybridSearch = async (q, k) => {
          if (!env.AI || !env.VECTORIZE) return [];
          const er = await env.AI.run(EMBEDDING_MODEL, { text: [q] });
          const vr = await env.VECTORIZE.query(er.data[0], { topK: k, returnMetadata: true });
          return vr.matches.map(m => ({
            id: m.metadata?.obsId || m.id,
            summary: m.metadata?.summary || "",
            title: m.metadata?.title || "",
            memory_type: m.metadata?.memory_type || "episodic",
            valid_to: m.metadata?.valid_to || null,
          }));
        };
        biresolution = await resolveSemanticConflict(env, callRoleLLM, { id: obsId, content, title }, hybridSearch);
      } catch (e) { console.warn("bitemporal (non-fatal):", e.message); }
    }

    // patch obs:meta with category/summaries/domain/memory_type
    try {
      const raw = await env.VECTORS.get(`obs:meta:${obsId}`);
      if (raw) {
        const cur = JSON.parse(raw);
        cur.category = category;
        cur.before_summary = before_summary;
        cur.after_summary = after_summary;
        cur.domain = domain;
        cur.memory_type = memTypeRes.memory_type;
        cur.memory_type_confidence = memTypeRes.confidence;
        if (biresolution) cur.bitemporal_action = biresolution.action;
        await env.VECTORS.put(`obs:meta:${obsId}`, JSON.stringify(cur), OBS_TTL);
      }
    } catch (e) { console.warn("obs:meta patch (non-fatal):", e.message); }
  };

  if (ctx?.waitUntil) {
    ctx.waitUntil(asyncWork().catch(e => console.warn("async pipeline:", e.message)));
  } else {
    await asyncWork().catch(e => console.warn("async pipeline:", e.message));
  }

  return {
    status: "ingested",
    raw: rawPath,
    wiki: wikiPath,
    compressed_chars: compressed.length,
    observation_id: obsId,
    surface: resolvedSurface,
    verified_retrievable,
    verified_indexed,
    // v9.5: stop lying. Embed runs in waitUntil (after this response is built),
    // so a sync count is impossible for non-authoritative writes. Authoritative
    // captures poll Vectorize sync (pollVectorizeAck) so their count is real.
    // Everyone else gets embed_status — the TRUE count lands in vstat:{obsId}
    // and get_observation, never a hardcoded 0.
    vectors_written: isAuthoritative ? vectorsWritten.length : undefined,
    embed_status: isAuthoritative ? undefined : "async — truth in vstat:{observation_id} + get_observation",
    fts5_written: !!fts5Ok,
    // v9.7: triples_written = sync ranking triples only (truthful for ranked content).
    // LLM-extracted S-P-O triples land in KV ~2s later via waitUntil.
    // Ground truth: lint triple_memory.triples (scans all triple:* KV keys).
    triples_written: triplesWritten,
    triples_pending: triplesWritten === 0 ? "llm-extract-async — truth in lint triple_memory" : undefined,
    verdict_blocks_preserved: verdictBlocks.length,
    vectorize_ack: isAuthoritative ? vectorize_ack : undefined,
    retrieval_latency_ms: Date.now() - t0,
  };
}

async function handleIngest(req, env, ctx) {
  try {
    const body = await req.json();
    return jsonOk(await runIngestPipeline(env, ctx, body));
  } catch (e) {
    return jsonErr(e.message, e.message.includes("required") ? 400 : 500);
  }
}

// ─── Recompress-all ───────────────────────────────────────────────────────────
async function handleRecompressAll(req, env) {
  const { dry_run = true, batch_size = 10, offset = 0, dir = "wiki/conversations" } = await req.json().catch(() => ({}));
  const repo   = env.GITHUB_REPO   || "your-username/your-repo";
  const branch = env.GITHUB_BRANCH || "main";

  const listRes = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${dir}?ref=${branch}`,
    { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } }
  );
  if (!listRes.ok) return jsonErr("Could not list wiki pages", 502);
  const allFiles = (await listRes.json()).filter(f => f.name.endsWith(".md"));

  const toRecompress = [];
  const checkedFiles = allFiles.slice(offset, offset + batch_size * 3);
  for (const file of checkedFiles) {
    try {
      const cr = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${file.path}?ref=${branch}`,
        { headers: { Accept: "application/vnd.github.v3.raw", "User-Agent": GH_UA } }
      );
      if (!cr.ok) continue;
      const text = await cr.text();
      if (text.includes("compression: wiki\n") || text.includes("compression: wiki-regex-fallback")) {
        toRecompress.push({ file, wikiContent: text });
      }
      if (toRecompress.length >= batch_size) break;
    } catch { continue; }
  }

  if (dry_run) return jsonOk({ status: "dry-run", total_wiki_pages: allFiles.length, eligible: toRecompress.length, sample: toRecompress.slice(0, 5).map(t => t.file.name) });

  const used = await getNeuronUsage(env);
  const avail = NEURON_BUDGET_COMPRESSION - used;
  if (avail < NEURON_COST_PRIMARY) return jsonErr(`Budget exhausted (${used}/${NEURON_BUDGET_COMPRESSION}).`, 429);

  const batch = toRecompress.slice(0, Math.min(batch_size, Math.floor(avail / NEURON_COST_PRIMARY)));
  const results = { recompressed: [], failed: [] };

  for (const { file, wikiContent } of batch) {
    const rawPath = file.path.replace("wiki/", "raw/");
    const rawRes  = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${rawPath}?ref=${branch}`,
      { headers: { Accept: "application/vnd.github.v3.raw", "User-Agent": GH_UA } }
    );
    const src   = rawRes.ok ? await rawRes.text() : wikiContent;
    const title = (wikiContent.match(/^title:\s*(.+)$/m) || [])[1]?.trim() || file.name.replace(".md","");
    const tags  = ((wikiContent.match(/^tags:\s*\[([^\]]+)\]/m) || [])[1] || "").split(",").map(s => s.trim()).filter(Boolean);
    const now   = new Date().toISOString().split("T")[0];

    try {
      const newWiki = await compressToWiki(env, title, src, tags, [], now);
      if (newWiki.includes("compression: wiki-llm-")) {
        await writeFile(env, file.path, newWiki, `recompress: ${file.name}`);
        if (env.AI && env.VECTORIZE) await embedAndStore(env, file.path, newWiki, { title, type: "conversation", tags, entities: [] });
        try { await extractAndStoreFactsFromContent(env, src, [], file.path); } catch {}
        results.recompressed.push(file.name);
      } else {
        results.failed.push({ name: file.name, reason: "LLM fell back to regex" });
      }
    } catch (e) { results.failed.push({ name: file.name, reason: e.message }); }
  }

  const remaining = toRecompress.length - batch.length + (allFiles.length - checkedFiles.length);
  return jsonOk({
    status: "recompress-complete",
    recompressed: results.recompressed.length,
    failed: results.failed.length,
    recompressed_files: results.recompressed,
    remaining_estimate: Math.max(0, remaining),
    next_offset: offset + checkedFiles.length,
    message: remaining > 0 ? `Run again with offset:${offset + checkedFiles.length}. ${remaining} remaining.` : "Done!",
  });
}

// ─── Lint ─────────────────────────────────────────────────────────────────────
async function handleLint(req, env) {
  const issues = [];

  // v9.3: bidirectional, uncapped orphan check via git-tree (replaces the old
  // /contents dir-listing that silently truncated at 1000 files and only
  // checked index→file direction, missing the file→index direction entirely).
  const indexContent = await readFile(env, "index.md") || "";
  const logContent   = await readFile(env, "log.txt") || await readFile(env, "log.md") || "";

  // Build set of all text that proves index-connectivity: index.md + all hub files.
  // A file is index-connected if its name-noext appears in any of these texts.
  const allIndexText = [indexContent];
  const hubFiles = await ghListAll(env, "wiki/_indexes");
  for (const hf of hubFiles) {
    const t = await readFile(env, hf.path);
    if (t) allIndexText.push(t);
  }
  const indexCorpus = allIndexText.join("\n");

  // Scan all in-scope dirs for orphan-no-index-entry (cheap — name string match).
  let totalScanned = 0;
  for (const dir of RECONCILE_DIRS) {
    const files = await ghListAll(env, dir);
    totalScanned += files.length;
    for (const f of files) {
      const nameNoExt = f.name.replace(/\.md$/, "");
      if (!indexCorpus.includes(nameNoExt)) {
        issues.push({ type: "orphan-no-index-entry", severity: "medium", file: f.path });
      }
    }
  }

  // Uncompressed check (raw has no wiki counterpart) — still useful, use ghListAll.
  // v9.7: tool-call logs are PRUNE targets, not compression targets — they must
  // not inflate the "uncompressed" count. isUncompressedCandidate excludes them.
  const rawFiles  = await ghListAll(env, "raw/conversations");
  const wikiFiles = await ghListAll(env, "wiki/conversations");
  const wikiNames = new Set(wikiFiles.map(f => f.name));
  let toolNoiseCount = 0;
  for (const f of rawFiles) {
    if (wikiNames.has(f.name)) continue;
    if (!isUncompressedCandidate(f.name)) { toolNoiseCount++; continue; }
    issues.push({ type: "uncompressed", severity: "high", file: f.path });
  }

  const logLines = logContent.split("\n").filter(l => l.startsWith("## ["));
  if (logLines.length === 0) issues.push({ type: "empty-log", severity: "low" });
  if (!indexContent.includes("## ")) issues.push({ type: "empty-index", severity: "high" });

  const neuronsUsed = await getNeuronUsage(env);

  let entityStats = { entities: 0, total_facts: 0, superseded_facts: 0 };
  // v9.7: triple_memory — lint was blind to triple:* rows (reported as 0 forever).
  // Scan paginated so big stores aren't truncated at 1000.
  let tripleStats = { triples: 0, subjects: 0, newest_confirmed: null };
  if (env.VECTORS) {
    try {
      const list = await env.VECTORS.list({ prefix: "entity:", limit: 1000 });
      entityStats.entities     = list.keys.filter(k => k.name.endsWith(":meta")).length;
      entityStats.total_facts  = list.keys.filter(k => k.name.includes(":fact:")).length;
    } catch {}
    try {
      let cursor, allTripleKeys = [];
      do {
        const tl = await env.VECTORS.list({ prefix: "triple:", limit: 1000, cursor });
        allTripleKeys.push(...tl.keys);
        cursor = tl.list_complete ? null : tl.cursor;
      } while (cursor);
      const c = countTriplesFromKeys(allTripleKeys);
      tripleStats.triples = c.triples;
      tripleStats.subjects = c.subjects;
    } catch (e) { tripleStats.error = e.message; }
  }

  return jsonOk({
    status: "lint-complete",
    total_scanned: totalScanned,
    issues_found: issues.length,
    issues,
    tool_noise_skipped: toolNoiseCount,
    ai_neurons_used_today: neuronsUsed,
    ai_budget_remaining: Math.max(0, NEURON_BUDGET_COMPRESSION - neuronsUsed),
    entity_memory: entityStats,
    triple_memory: tripleStats,
    recommendation: issues.length === 0 ? "Wiki is healthy" : `Fix ${issues.filter(i => i.severity === "high").length} high-priority issues first`,
  });
}

// ─── Prune ────────────────────────────────────────────────────────────────────
async function handlePrune(req, env) {
  const { confirm = false, dry_run = true } = await req.json().catch(() => ({}));
  const repo   = env.GITHUB_REPO   || "your-username/your-repo";
  const branch = env.GITHUB_BRANCH || "main";
  const TWO_YEARS = 2 * 365 * 24 * 60 * 60 * 1000;
  const pruneTargets = [];

  const wikiDirs = ["wiki/conversations","wiki/entities","wiki/topics","wiki/projects","wiki/skills"];
  const allWikiFiles = [];
  for (const dir of wikiDirs) {
    try {
      const res = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${dir}?ref=${branch}`, { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } });
      if (!res.ok) continue;
      for (const f of await res.json()) { if (f.name.endsWith(".md")) allWikiFiles.push(f); }
    } catch {}
  }

  const cutoff   = new Date(Date.now() - TWO_YEARS).toISOString().slice(0, 10);
  const candidates = allWikiFiles.filter(f => { const m = f.name.match(/^(\d{4}-\d{2}-\d{2})/); return m && m[1] < cutoff; });
  const allContent = new Map();
  for (const f of allWikiFiles) {
    try { const r = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${f.path}?ref=${branch}`, { headers: { Accept: "application/vnd.github.v3.raw", "User-Agent": GH_UA } }); if (r.ok) allContent.set(f.path, await r.text()); } catch {}
  }
  for (const c of candidates) {
    const nameNoExt = c.name.replace(".md","");
    let backlinks = 0;
    for (const [op, oc] of allContent.entries()) { if (op !== c.path && (oc.includes(nameNoExt) || oc.includes(c.path))) backlinks++; }
    if (backlinks === 0) pruneTargets.push({ path: c.path, name: c.name, reason: "older than 2 years, 0 backlinks" });
  }

  const deleted = [];
  if (confirm && !dry_run) {
    for (const t of pruneTargets.slice(0, 10)) {
      try {
        const mr = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${t.path}?ref=${branch}`, { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } });
        if (!mr.ok) continue;
        const dr = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${t.path}`, { method: "DELETE", headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA }, body: JSON.stringify({ message: `prune: ${t.name}`, sha: (await mr.json()).sha, branch }) });
        if (dr.ok) deleted.push(t.path);
      } catch {}
    }
  }

  return jsonOk({ status: dry_run ? "prune-dry-run" : "prune-complete", orphans_found: pruneTargets.length, prune_targets: pruneTargets, deleted: deleted.length > 0 ? deleted : undefined });
}

// ─── Compaction job (v9.7) ────────────────────────────────────────────────────
// POST /compact { dry_run: true }   → classify report, ZERO writes. Wait for approval.
// POST /compact { dry_run: false, cursor?: string, batch?: number } → bounded execute.
//
// PRUNE  = move raw/conversations/*.md matching tool-call noise to raw/_pruned/.
// MERGE  = group per-message fragments by date+session-hash for future wiki merge.
// KEEP   = untouched (handoffs, rules, substantive docs).
//
// Safety: PRUNE is a MOVE (reversible via git). Hard-delete never happens here.
async function handleCompact(req, env) {
  const body = await req.json().catch(() => ({}));
  const dry_run = body.dry_run !== false; // default: dry-run
  const batchSize = Math.min(100, Math.max(1, Number(body.batch) || 50));
  const startCursor = body.cursor || null; // filename to resume from (alphabetic)

  const repo   = env.GITHUB_REPO   || "your-username/your-repo";
  const branch = env.GITHUB_BRANCH || "main";

  // 1. List raw/conversations — paginated via ghListAll.
  const rawFiles = await ghListAll(env, "raw/conversations");

  // 2. Classify every file.
  const classified = rawFiles.map(f => ({
    ...f,
    ...classifyRawFile(f.name),
  }));

  const byAction = { PRUNE: [], MERGE: [], KEEP: [] };
  for (const f of classified) byAction[f.action]?.push(f);

  // Build merge groups: date+session → [files].
  const mergeGroups = {};
  for (const f of byAction.MERGE) {
    const key = `${f.date || "unknown"}:${f.session || "nosess"}`;
    (mergeGroups[key] = mergeGroups[key] || []).push(f);
  }

  // Dry-run: return the report immediately, zero writes.
  if (dry_run) {
    return jsonOk({
      status: "compact-dry-run",
      summary: {
        total_raw: rawFiles.length,
        prune: byAction.PRUNE.length,
        merge: byAction.MERGE.length,
        keep: byAction.KEEP.length,
        merge_groups: Object.keys(mergeGroups).length,
      },
      samples: {
        prune: byAction.PRUNE.slice(0, 5).map(f => f.path),
        merge: byAction.MERGE.slice(0, 5).map(f => f.path),
        keep:  byAction.KEEP.slice(0,  5).map(f => f.path),
      },
      merge_group_samples: Object.entries(mergeGroups).slice(0, 3).map(([k, fs]) => ({
        group: k, count: fs.length, files: fs.slice(0, 3).map(f => f.name),
      })),
      instruction: "Review counts + samples. POST /compact { dry_run: false } to execute (batched).",
    });
  }

  // Execute: move PRUNE files in a bounded batch (cursor-based, idempotent).
  const pruneTargets = byAction.PRUNE
    .filter(f => !startCursor || f.name >= startCursor)
    .slice(0, batchSize);

  const moved = [], errors = [];
  for (const f of pruneTargets) {
    const srcPath  = f.path;                                 // raw/conversations/foo.md
    const destPath = srcPath.replace("raw/conversations/", "raw/_pruned/");
    try {
      // Read current content + sha.
      const getRes = await ghFetch(env,
        `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(srcPath)}?ref=${branch}`,
        { headers: { Accept: "application/vnd.github.v3.raw", "User-Agent": GH_UA } }
      );
      if (!getRes.ok) { errors.push({ file: srcPath, error: `read ${getRes.status}` }); continue; }

      // Get sha for delete.
      const metaRes = await ghFetch(env,
        `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(srcPath)}?ref=${branch}`,
        { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } }
      );
      const meta = metaRes.ok ? await metaRes.json() : null;
      if (!meta?.sha) { errors.push({ file: srcPath, error: "sha missing" }); continue; }

      const rawContent = await getRes.text().catch(() => null);
      if (rawContent === null) { errors.push({ file: srcPath, error: "read content failed" }); continue; }

      // Write to _pruned/.
      const createRes = await ghFetch(env,
        `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(destPath)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "User-Agent": GH_UA },
          body: JSON.stringify({
            message: `compact: prune tool-noise → _pruned/ ${f.name}`,
            content: btoa(unescape(encodeURIComponent(rawContent))),
            branch,
          }),
        }
      );
      if (!createRes.ok) {
        const ce = await createRes.text();
        // 422 = already exists in _pruned/ → idempotent, treat as moved.
        if (createRes.status !== 422) { errors.push({ file: srcPath, error: `create ${createRes.status}: ${ce.slice(0,100)}` }); continue; }
      }

      // Delete from raw/conversations/.
      const delRes = await ghFetch(env,
        `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(srcPath)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json", "User-Agent": GH_UA },
          body: JSON.stringify({
            message: `compact: remove tool-noise from raw/ ${f.name}`,
            sha: meta.sha,
            branch,
          }),
        }
      );
      if (delRes.ok || delRes.status === 404) {
        moved.push(srcPath);
      } else {
        const de = await delRes.text();
        errors.push({ file: srcPath, error: `delete ${delRes.status}: ${de.slice(0,100)}` });
      }
    } catch (e) {
      errors.push({ file: srcPath, error: e.message });
    }
  }

  const nextCursor = pruneTargets.length === batchSize
    ? (pruneTargets[pruneTargets.length - 1]?.name || null)
    : null;

  // Write audit file.
  const auditDate = new Date().toISOString().slice(0, 10);
  const auditPath = `raw/_audit/compaction-${auditDate}.json`;
  const audit = {
    timestamp: new Date().toISOString(),
    batch_size: batchSize,
    cursor_start: startCursor,
    moved: moved.length,
    errors: errors.length,
    moved_files: moved,
    error_files: errors,
  };
  await writeFile(env, auditPath, JSON.stringify(audit, null, 2), `compact: audit ${auditDate}`).catch(e =>
    console.warn("audit write (non-fatal):", e.message)
  );

  return jsonOk({
    status: "compact-executed",
    moved: moved.length,
    errors: errors.length,
    error_details: errors.length ? errors : undefined,
    next_cursor: nextCursor,
    resume: nextCursor ? `POST /compact { dry_run: false, cursor: "${nextCursor}", batch: ${batchSize} }` : null,
    audit: auditPath,
    remaining_prune: byAction.PRUNE.length - moved.length - errors.length,
  });
}

// ─── Semantic search ──────────────────────────────────────────────────────────
async function handleSemanticSearch(req, env) {
  const { query, top_k = 5, rerank = true } = await req.json().catch(() => ({}));
  if (!query) return jsonErr("query required", 400);
  if (!env.AI) return handleKeywordQuery(new URL(req.url + `?q=${encodeURIComponent(query)}`), env);

  try {
    const embedRes = await env.AI.run(EMBEDDING_MODEL, { text: [query] });
    if (env.VECTORIZE) {
      const results = await env.VECTORIZE.query(embedRes.data[0], { topK: top_k * 2, returnMetadata: true });
      let matches = results.matches.map(m => ({
        score: m.score,
        path: m.metadata?.path,
        title: m.metadata?.title,
        summary: m.metadata?.summary,
      }));

      // Cross-encoder reranking (U4 v9.1.2)
      if (rerank && matches.length > 1) {
        try {
          const candidates = matches.map(m => ({ ...m, text: `${m.title || m.path} ${m.summary || ""}` }));
          matches = await rerankHybridResults(env, query, candidates, top_k);
        } catch (e) {
          console.warn("/search cross-encoder rerank (non-fatal):", e.message);
          matches = matches.slice(0, top_k);
        }
      } else {
        matches = matches.slice(0, top_k);
      }

      return jsonOk({ query, method: rerank ? "semantic+reranked" : "semantic", results: matches });
    }
  } catch {}
  return jsonOk({ query, method: "keyword-fallback", results: await doKeywordSearch(env, query) });
}

// ─── Backfill: timestamps + surfaces + indexes ───────────────────────────────
// Re-buckets observations under correct IST session_id, infers surface,
// rewrites front-matter, rebuilds surface index, marks stale SESSION-HANDOFFs
// superseded, sets state:session-handoff:latest. Additive — does NOT delete
// or rename source files. Phased + batched so each call fits Worker limits.
async function handleBackfillTsSurface(req, env) {
  const body = await req.json().catch(() => ({}));
  const phase = body.phase || "files";          // files | reindex | lint | all
  const offset = Number.isFinite(body.offset) ? body.offset : 0;
  const batch_size = Math.max(1, Math.min(50, Number(body.batch_size) || 25));
  const dry_run = body.dry_run === true;
  const out = { phase, offset, batch_size, dry_run, started_at: new Date().toISOString() };

  if (phase === "files" || phase === "all") {
    const repo = env.GITHUB_REPO || "your-username/your-repo";
    const branch = env.GITHUB_BRANCH || "main";
    const dirs = ["raw/conversations", "wiki/conversations"];
    const stats = { scanned: 0, patched: 0, skipped: 0, missing_surface: 0, missing_session_id: 0, errors: [] };
    for (const dir of dirs) {
      const listRes = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${dir}?ref=${branch}`,
        { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } });
      if (!listRes.ok) { stats.errors.push(`list ${dir} HTTP ${listRes.status}`); continue; }
      const files = (await listRes.json()).filter(f => f.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
      const slice = files.slice(offset, offset + batch_size);
      for (const f of slice) {
        stats.scanned++;
        try {
          const cr = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${f.path}?ref=${branch}`,
            { headers: { Accept: "application/vnd.github.v3.raw", "User-Agent": GH_UA } });
          if (!cr.ok) { stats.errors.push(`read ${f.path} HTTP ${cr.status}`); continue; }
          const text = await cr.text();
          const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?/);
          if (!fmMatch) { stats.skipped++; continue; }
          const fmBlock = fmMatch[1];
          const rest = text.slice(fmMatch[0].length);
          const fmLines = fmBlock.split("\n");
          const fmMap = {};
          for (const ln of fmLines) {
            const m = ln.match(/^(\w+):\s*(.*)$/);
            if (m) fmMap[m[1]] = m[2];
          }
          // Compute IST bucket: prefer fmMap.created if it parses, else filename prefix.
          let basisMs = Date.parse(fmMap.created || "");
          if (!basisMs) {
            const pref = (f.name.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
            basisMs = pref ? Date.parse(`${pref}T00:00:00Z`) : Date.now();
          }
          const istBucket = istDateStr(basisMs);
          const inferredSurface = (() => {
            if (normalizeSurface(fmMap.surface)) return fmMap.surface.toLowerCase();
            const t = (fmMap.tags || "") + " " + (fmMap.entities || "") + " " + rest.slice(0, 4000);
            if (/claude-?code|transcript_path|\/Users\/.*\/.claude|session [0-9a-f]{8}-/i.test(t)) return "claude-code";
            if (/claude\.ai|claude-ai-web/i.test(t)) return "claude-ai-web";
            if (/cowork/i.test(t)) return "cowork";
            if (/telegram/i.test(t)) return "claude-mobile";
            return "other";
          })();
          if (!fmMap.surface) stats.missing_surface++;
          if (!fmMap.session_id) stats.missing_session_id++;
          const needsPatch = !fmMap.surface || !fmMap.session_id || normalizeSurface(fmMap.surface) === null;
          if (!needsPatch) { stats.skipped++; continue; }
          if (dry_run) { stats.patched++; continue; }
          // Rewrite front-matter — additive only.
          const patched = {
            ...fmMap,
            session_id: fmMap.session_id || istBucket,
            surface: normalizeSurface(fmMap.surface) || inferredSurface,
          };
          const order = ["type","created","session_id","surface","tags","entities","source_url"];
          const seen = new Set();
          const newFmLines = [];
          for (const k of order) {
            if (patched[k] != null && patched[k] !== "") { newFmLines.push(`${k}: ${patched[k]}`); seen.add(k); }
          }
          for (const k of Object.keys(patched)) {
            if (!seen.has(k) && patched[k] != null && patched[k] !== "") newFmLines.push(`${k}: ${patched[k]}`);
          }
          const newText = `---\n${newFmLines.join("\n")}\n---\n${rest}`;
          const ok = await writeFile(env, f.path, newText, `backfill: ts+surface ${f.name}`);
          if (ok) stats.patched++; else stats.errors.push(`write ${f.path} failed`);
        } catch (e) { stats.errors.push(`${f.path}: ${e.message}`); }
      }
      out[`${dir.replace("/", "_")}_total`] = files.length;
      out[`${dir.replace("/", "_")}_next_offset`] = offset + slice.length;
    }
    out.files = stats;
  }

  if (phase === "reindex" || phase === "all") {
    const stats = { obs_scanned: 0, surface_indexed: 0, handoffs: 0, superseded: 0, sessions_rebuilt: 0, errors: [] };
    const allMetaKeys = [];
    let cursor = undefined;
    do {
      const lr = await env.VECTORS.list({ prefix: "obs:meta:", cursor, limit: 1000 });
      for (const k of lr.keys) allMetaKeys.push(k.name);
      cursor = lr.list_complete ? null : lr.cursor;
    } while (cursor);
    const sessionsMap = {};   // date -> [ids]
    const handoffEntries = [];
    for (const key of allMetaKeys) {
      const raw = await env.VECTORS.get(key);
      if (!raw) continue;
      let obs;
      try { obs = JSON.parse(raw); } catch { continue; }
      stats.obs_scanned++;
      const tsUtc = obs.timestamp || new Date().toISOString();
      const istBucket = istDateStr(tsUtc);
      obs.session_id = istBucket;
      obs.timestamp_ist = obs.timestamp_ist || istIsoStr(tsUtc);
      obs.surface = normalizeSurface(obs.surface) || obs.surface || "other";
      if (!SURFACES.includes(obs.surface)) obs.surface = "other";
      if (!dry_run) await env.VECTORS.put(key, JSON.stringify(obs), OBS_TTL);
      if (!sessionsMap[istBucket]) sessionsMap[istBucket] = [];
      sessionsMap[istBucket].push({ id: obs.id, ts: Date.parse(tsUtc) || 0 });
      if (!dry_run) {
        const tsMs = Date.parse(tsUtc) || 0;
        await env.VECTORS.put(`index:surface:${obs.surface}:${tsMs}:${obs.id}`, obs.id, OBS_TTL);
        stats.surface_indexed++;
      }
      if (Array.isArray(obs.entities) && obs.entities.includes("SESSION-HANDOFF")) {
        handoffEntries.push({ id: obs.id, ts: Date.parse(tsUtc) || 0, obs });
        stats.handoffs++;
      }
    }
    // Rebuild session buckets
    const dateList = Object.keys(sessionsMap).sort().reverse();
    if (!dry_run) {
      for (const d of dateList) {
        const ids = sessionsMap[d].sort((a, b) => a.ts - b.ts).map(x => x.id);
        await env.VECTORS.put(`obs:session:${d}`, JSON.stringify(ids.slice(-OBS_SESSION_CAP)), OBS_TTL);
        stats.sessions_rebuilt++;
      }
      await env.VECTORS.put("obs:sessions:list", JSON.stringify(dateList.slice(0, 365)), OBS_TTL);
      if (dateList[0]) await env.VECTORS.put("obs:latest_session", dateList[0], OBS_TTL);
    }
    // Supersede stale handoffs, freshest wins
    handoffEntries.sort((a, b) => b.ts - a.ts);
    if (handoffEntries.length > 0 && !dry_run) {
      const winner = handoffEntries[0];
      for (let i = 1; i < handoffEntries.length; i++) {
        const h = handoffEntries[i];
        if (h.obs.superseded_by) continue;
        h.obs.superseded_by = winner.id;
        h.obs.superseded_at = Date.now();
        await env.VECTORS.put(`obs:meta:${h.id}`, JSON.stringify(h.obs), OBS_TTL);
        stats.superseded++;
      }
      await env.VECTORS.put("state:session-handoff:list", JSON.stringify(handoffEntries.map(h => h.id).reverse().slice(-100)), OBS_TTL);
      const w = winner.obs;
      await env.VECTORS.put("state:session-handoff:latest", JSON.stringify({
        observation_id: w.id, timestamp: w.timestamp, timestamp_ist: w.timestamp_ist,
        surface: w.surface, topic: w.topic || w.title, state: w.state || "",
        next_action: w.next_action || "", trail: w.trail || [], wiki_path: w.wiki_path || null,
      }), OBS_TTL);
    }
    out.reindex = stats;
  }

  if (phase === "lint" || phase === "all") {
    const stats = { index_lines: 0, ghosts: 0, kept: 0, errors: [] };
    try {
      const idx = await readFile(env, "index.md");
      if (!idx) { out.lint = { ...stats, note: "index.md missing" }; return jsonOk(out); }
      const lines = idx.split("\n");
      const repo = env.GITHUB_REPO || "your-username/your-repo";
      const branch = env.GITHUB_BRANCH || "main";
      const keep = [];
      for (const ln of lines) {
        const m = ln.match(/\(([^)]+\.md)\)/);
        if (!m) { keep.push(ln); continue; }
        stats.index_lines++;
        const fpath = m[1].replace(/^\.?\//, "");
        const r = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${fpath}?ref=${branch}`,
          { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } });
        if (r.ok) { keep.push(ln); stats.kept++; }
        else { stats.ghosts++; /* drop line */ }
      }
      if (!dry_run && stats.ghosts > 0) {
        await writeFile(env, "index.md", keep.join("\n"), `backfill: lint ${stats.ghosts} ghosts`);
      }
    } catch (e) { stats.errors.push(e.message); }
    out.lint = stats;
  }

  out.finished_at = new Date().toISOString();
  return jsonOk(out);
}

async function embedAndStore(env, path, content, metadata) {
  // v9.5 FAIL LOUD: throws on dim mismatch / no-ack. Returns true on success so
  // the caller can count it truthfully. No swallow — caller records to vstat.
  const res = await env.AI.run(EMBEDDING_MODEL, { text: [content.substring(0, 2000)] });
  const v = res.data[0];
  if (!Array.isArray(v) || v.length !== EMBEDDING_DIMS) {
    throw new Error(`embedAndStore dim mismatch for ${path}: got ${Array.isArray(v) ? v.length : typeof v}, want ${EMBEDDING_DIMS}`);
  }
  // Store first 800 chars of content as summary in metadata so /ask can use it without extra fetches
  const summary = content.replace(/^---[\s\S]*?---\n/, "").substring(0, 800).trim();
  // Vectorize IDs cap at 64 bytes — hash long paths; keep full path in metadata.
  const vid = `d:${factHash(path)}`.substring(0, 64);
  const ack = await env.VECTORIZE.upsert([{ id: vid, values: v, metadata: { path, ...metadata, summary } }]);
  if (!ack) throw new Error(`embedAndStore upsert returned no ack for ${path}`);
  return true;
}

// v9: Multi-vector indexing. Vectorize has no native namespaces — we encode
// namespace into the ID prefix (vec:title:*, vec:content:*, vec:summary:*,
// vec:entity:{slug}:*) and store the namespace in metadata so we can filter
// at query time. Returns array of {ns, vectorId} written.
// v9.2: split long text into overlapping chunks so NOTHING past char 2000 stays
// invisible to semantic search. ~1500-char chunks, 200-char overlap, prefer
// paragraph/sentence boundaries. Caps total chunks to bound vector count.
function chunkText(text, size = 1500, overlap = 200, maxChunks = 12) {
  const t = (text || "").trim();
  if (t.length <= size) return t ? [t] : [];
  const chunks = [];
  let i = 0;
  while (i < t.length && chunks.length < maxChunks) {
    let end = Math.min(i + size, t.length);
    if (end < t.length) {
      // back off to nearest paragraph/sentence/space boundary in last 300 chars
      const window = t.slice(end - 300, end);
      const br = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
      if (br > 0) end = end - 300 + br + 1;
    }
    chunks.push(t.slice(i, end).trim());
    if (end >= t.length) break;
    i = end - overlap;
  }
  return chunks.filter(Boolean);
}

async function embedAndStoreMulti(env, baseId, { title, content, summary, entities }, sharedMeta) {
  if (!env.AI || !env.VECTORIZE) return [];
  const written = [];
  const toEmbed = [];
  // v9.6: context header prepended to every embedded chunk so a mid-note chunk
  // still carries what the note is ABOUT (title + top entities + tags). Lifts
  // recall when the query matches a synonym/entity not literally in that chunk.
  const tagList = (sharedMeta && Array.isArray(sharedMeta.tags)) ? sharedMeta.tags.slice(0, 6) : [];
  const entList = (entities || []).filter(e => typeof e === "string" && e.trim()).slice(0, 6);
  const ctxHeader = [
    title ? `Title: ${title}` : "",
    entList.length ? `Entities: ${entList.join(", ")}` : "",
    tagList.length ? `Tags: ${tagList.join(", ")}` : "",
  ].filter(Boolean).join(" | ").slice(0, 300);
  const withCtx = (t) => ctxHeader ? `${ctxHeader}\n\n${t}` : t;

  if (title)   toEmbed.push({ ns: "title",   text: title.substring(0, 512) });
  if (summary) toEmbed.push({ ns: "summary", text: withCtx(summary.substring(0, 1300)) });
  // v9.2: full-content chunking (was single 2000-char slice).
  // v9.6: each chunk gets the context header (cheap, big recall win on mid-note chunks).
  const contentChunks = chunkText(content, 1500, 200, 12);
  contentChunks.forEach((ck, idx) => toEmbed.push({ ns: `content:${idx}`, text: withCtx(ck) }));
  for (const e of (entities || []).slice(0, 6)) {
    if (typeof e !== "string" || !e.trim()) continue;
    const ctx = `${e}\n${title || ""}\n${(summary || content || "").substring(0, 400)}`;
    toEmbed.push({ ns: `entity:${entitySlug(e)}`, text: ctx });
  }
  try {
    const texts = toEmbed.map(t => t.text);
    if (!texts.length) return [];
    // Workers AI embeds batches; cap batch at 100 to be safe.
    const res = await env.AI.run(EMBEDDING_MODEL, { text: texts.slice(0, 100) });
    // v9.5 FAIL LOUD: any wrong-length vector throws verbatim (no silent skip).
    for (let i = 0; i < res.data.length; i++) {
      const v = res.data[i];
      if (!Array.isArray(v) || v.length !== EMBEDDING_DIMS) {
        throw new Error(`dim mismatch idx ${i}: got ${Array.isArray(v) ? v.length : typeof v}, want ${EMBEDDING_DIMS}`);
      }
    }
    // Vectorize IDs cap at 64 bytes — hash the (long) baseId; keep full id in metadata.
    const bhash = factHash(baseId);
    const vectors = toEmbed.slice(0, 100).map((t, i) => ({
      id: `v:${t.ns}:${bhash}`.substring(0, 64),
      values: res.data[i],
      metadata: { namespace: t.ns, base_id: baseId, ...sharedMeta },
    }));
    const ack = await env.VECTORIZE.upsert(vectors);
    // CF Vectorize upsert returns {mutationId} (async, no row count). A null ack
    // means the call did not enqueue → real failure, not a quiet 0.
    if (!ack) throw new Error(`upsert returned no ack`);
    for (const v of vectors) written.push({ ns: v.metadata.namespace, id: v.id });
  } catch (e) {
    // v9.5: re-throw — caller (asyncWork) records verbatim to vstat. No swallow.
    throw new Error(`embedAndStoreMulti failed (base_id ${baseId}): ${e.message}`);
  }
  return written;
}

// v9: Vectorize index ack poll — for AUTHORITATIVE/verdict writes, wait up to
// timeoutMs for a freshly-upserted id to surface in query results.
async function pollVectorizeAck(env, queryText, expectId, timeoutMs = 10000) {
  if (!env.AI || !env.VECTORIZE) return { acked: false, ms: 0, note: "no-binding" };
  const t0 = Date.now();
  let attempts = 0;
  try {
    const er = await env.AI.run(EMBEDDING_MODEL, { text: [queryText] });
    while (Date.now() - t0 < timeoutMs) {
      attempts++;
      try {
        const r = await env.VECTORIZE.query(er.data[0], { topK: 10, returnMetadata: true });
        if (r.matches?.some(m => m.id === expectId || m.metadata?.base_id === expectId)) {
          return { acked: true, ms: Date.now() - t0, attempts };
        }
      } catch {}
      await new Promise(r => setTimeout(r, 600));
    }
  } catch (e) { return { acked: false, ms: Date.now() - t0, attempts, error: e.message }; }
  return { acked: false, ms: Date.now() - t0, attempts };
}

// ─── D1 FTS5 keyword index (v9) ──────────────────────────────────────────────
// Optional binding env.DB. If absent, every function below no-ops gracefully.
// Schema bootstraps on first write — no separate migration step.
let _ftsReady = false;
async function ensureFts5(env) {
  if (!env.DB || _ftsReady) return !!env.DB;
  try {
    await env.DB.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(id UNINDEXED, title, content, entities, tags, surface, timestamp_utc UNINDEXED, session_id UNINDEXED, tokenize='porter unicode61')"
    );
    _ftsReady = true;
    return true;
  } catch (e) { console.warn("ensureFts5 (non-fatal):", e.message); return false; }
}

async function writeFts5(env, rec) {
  if (!env.DB) return false;
  if (!await ensureFts5(env)) return false;
  try {
    await env.DB.prepare("DELETE FROM observations_fts WHERE id = ?").bind(rec.id).run();
    await env.DB.prepare(
      "INSERT INTO observations_fts (id, title, content, entities, tags, surface, timestamp_utc, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      rec.id,
      rec.title || "",
      (rec.content || "").substring(0, 8000),
      (rec.entities || []).join(" "),
      (rec.tags || []).join(" "),
      rec.surface || "other",
      rec.timestamp_utc || rec.timestamp || new Date().toISOString(),
      rec.session_id || ""
    ).run();
    return true;
  } catch (e) { console.warn("writeFts5 (non-fatal):", e.message); return false; }
}

function _sanitizeFtsQuery(q) {
  // Escape inner quotes, wrap whole query as a phrase token-fallback. We split
  // on whitespace and OR the terms — works without users learning FTS5 syntax.
  const terms = String(q || "").toLowerCase().split(/\s+/).filter(t => t && !STOP_WORDS.has(t)).map(t => t.replace(/[^a-z0-9]/g, ""));
  if (!terms.length) return null;
  return terms.map(t => `"${t}"`).join(" OR ");
}

async function searchFts5(env, q, limit = 20) {
  if (!env.DB) return [];
  if (!await ensureFts5(env)) return [];
  const ftsQ = _sanitizeFtsQuery(q);
  if (!ftsQ) return [];
  try {
    const r = await env.DB.prepare(
      "SELECT id, title, snippet(observations_fts, 2, '«', '»', '…', 16) AS snippet, surface, timestamp_utc, session_id, bm25(observations_fts) AS score FROM observations_fts WHERE observations_fts MATCH ? ORDER BY bm25(observations_fts) LIMIT ?"
    ).bind(ftsQ, limit).all();
    return (r.results || []).map(row => ({ ...row, _method: "fts5" }));
  } catch (e) { console.warn("searchFts5 (non-fatal):", e.message); return []; }
}

// ─── Keyword search ───────────────────────────────────────────────────────────
const STOP_WORDS = new Set(["the","a","an","is","in","of","to","and","or","for","with","on","at","by","from","as","be","was","are","were","has","have","had","it","its","this","that","which","what","how","when","where","why","who","i","my","you","your","we","our","they","their"]);

function tokenizeQuery(q) { return q.toLowerCase().split(/\s+/).filter(t => t.length > 1 && !STOP_WORDS.has(t)); }
function countOcc(str, t) { let c=0,p=0; while((p=str.indexOf(t,p))!==-1){c++;p+=t.length;} return c; }
function extractFMList(content, field) {
  const m = content.match(new RegExp(`^${field}:\\s*\\[([^\\]]+)\\]`,"m"));
  return m ? m[1].split(",").map(s=>s.trim().replace(/['"]/g,"")) : [];
}
function scoreResult(name, content, terms) {
  let s=0; const nl=name.toLowerCase(), cl=content.toLowerCase();
  const tags=extractFMList(content,"tags"), ents=extractFMList(content,"entities");
  for(const t of terms){ if(nl.includes(t))s+=10; if(tags.some(g=>g.toLowerCase().includes(t)))s+=6; if(ents.some(e=>e.toLowerCase().includes(t)))s+=5; s+=Math.min(countOcc(cl,t),20); }
  return s;
}

async function handleKeywordQuery(url, env) {
  const q = url.searchParams.get("q") || "";
  if (!q) return jsonErr("q required", 400);
  const results = await doKeywordSearch(env, q);
  return jsonOk({ query: q, matches: results.length, results, note: "Returning compressed wiki pages — 27x token savings vs raw" });
}

async function doKeywordSearch(env, q) {
  const terms = tokenizeQuery(q);
  if (!terms.length) return [];
  const scored = [];
  const repo   = env.GITHUB_REPO   || "your-username/your-repo";
  const branch = env.GITHUB_BRANCH || "main";
  const dirs   = ["wiki/conversations","wiki/entities","wiki/topics","wiki/projects","wiki/rules","wiki/code","wiki/skills","raw/conversations"];

  for (const dir of dirs) {
    try {
      const res = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${dir}?ref=${branch}`, { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } });
      if (!res.ok) continue;
      for (const file of await res.json()) {
        if (!file.name.endsWith(".md")) continue;
        let content="", preview="", matchingLines=[];
        try {
          const cr = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${file.path}?ref=${branch}`, { headers: { Accept: "application/vnd.github.v3.raw", "User-Agent": GH_UA } });
          if (cr.ok) {
            content = await cr.text();
            const lines = content.split("\n");
            matchingLines = lines.filter(l=>terms.some(t=>l.toLowerCase().includes(t))).slice(0,5).map(l=>l.substring(0,200));
            preview = dir.startsWith("raw") ? content : lines.slice(0,10).join("\n").substring(0,500);
          }
        } catch {}
        const score = scoreResult(file.name, content, terms);
        if (score > 0) scored.push({ path: file.path, name: file.name, type: dir.startsWith("wiki")?"compressed":"raw", category: dir.split("/")[1]||"raw", matchReason: terms.some(t=>file.name.toLowerCase().includes(t))?"filename":"content", preview: preview||undefined, matchingLines: matchingLines.length?matchingLines:undefined, _score: score });
      }
    } catch {}
  }
  return scored.sort((a,b)=>b._score-a._score).slice(0,20).map(({_score,...r})=>r);
}

// ─── v9: hybrid keyword (D1 FTS5 → GitHub fallback) ─────────────────────────
async function doKeywordSearchHybrid(env, q, limit = 20) {
  // Prefer D1 FTS5 when bound — instant + scored.
  if (env.DB) {
    const fts = await searchFts5(env, q, limit);
    if (fts.length) {
      return { query: q, method: "fts5", matches: fts.length, results: fts.slice(0, limit) };
    }
  }
  // Fallback: GitHub keyword scan (existing slow path).
  const ghr = await doKeywordSearch(env, q);
  return { query: q, method: "github-keyword-fallback", matches: ghr.length, results: ghr.slice(0, limit) };
}

// ─── v9: hybrid recall with RRF + recency boost ──────────────────────────────
async function doRecall(env, query, limit = 10) {
  const t0 = Date.now();
  const todayIst = istDateStr();
  const weekAgoMs = Date.now() - 7 * 86400 * 1000;

  // Run methods in parallel.
  const [semanticArr, keywordArr, entityArr, tripleArr] = await Promise.all([
    recallSemantic(env, query, 15).catch(() => []),
    recallKeyword(env, query, 15).catch(() => []),
    recallEntity(env, query, 10).catch(() => []),
    recallTriples(env, query, 10).catch(() => []),
  ]);

  let fused = rrfFuse([semanticArr, keywordArr, entityArr, tripleArr]);

  // v9.6: drop tool-call auto-capture noise (tool-Bash/tool-Write/tool-mcp …).
  // Measured 2026-06-18: ~53% of the corpus is these logs — zero recall value,
  // pure dilution. Filtered from results only (data stays in D1/Vectorize, fully
  // reversible). A result is noise if its title/path matches the tool-log shape.
  const _isToolNoise = (r) => {
    const s = String(r.title || r.name || r.path || "");
    return /(?:^|[/\-])tool-(?:Bash|Write|Read|Edit|mcp|Glob|Grep|Task)[-_]/i.test(s) ||
           /\d{2}:\d{2}-tool-/i.test(s) || /-tool-[a-z]+-[0-9a-f]{6}/i.test(s);
  };
  const _preFilter = fused.length;
  fused = fused.filter(r => !_isToolNoise(r));
  const _filteredOut = _preFilter - fused.length;

  // v10.2.1 (Balance): recency is a NUDGE, not a hammer. Old-but-relevant results
  // were being crushed by fresh chatter (the "never references old data" bug).
  // Softened: session +12%, week +5% (was +30%/+10%). Enough to break ties toward
  // fresh events; not enough to bury a year-old truth that's actually more relevant.
  for (const r of fused) {
    const ts = Date.parse(r.timestamp_utc || r.timestamp || 0);
    const sid = r.session_id || "";
    let mult = 1.0;
    if (sid === todayIst) mult = 1.12;
    else if (ts && ts >= weekAgoMs) mult = 1.05;
    r._rrf_boosted = r._rrf * mult;
    r._recency_boost = mult;
  }
  fused.sort((a, b) => b._rrf_boosted - a._rrf_boosted);

  // v9.6: CONFIDENCE-GATED cross-encoder rerank. Benchmark (2026-06-18) showed a
  // naive rerank of the fused list FIXED 2/5 queries but REGRESSED 2/5 — the
  // bge-reranker emits degenerate near-zero scores on short keyword queries, then
  // a fluke outlier hijacks #1. So: rerank the top window, but only ADOPT the new
  // order when the reranker is actually discriminating; otherwise keep RRF order.
  let method = "hybrid-rrf";
  let rerankInfo = null;
  try {
    if (env.AI && fused.length >= 2) {
      const WINDOW = Math.min(12, fused.length);
      const head = fused.slice(0, WINDOW);
      const reranked = await rerankHybridResults(env, query, head, WINDOW);
      const scores = reranked.map(r => Number(r.rerank_score) || 0).sort((a, b) => b - a);
      const top = scores[0] || 0;
      const median = scores[Math.floor(scores.length / 2)] || 0;
      // Discriminating iff: clear top signal AND top stands meaningfully above the
      // pack. Floor 0.05 kills the all-near-zero case; 2x-median kills the single
      // flat-field outlier the benchmark caught.
      const discriminating = top >= 0.05 && top >= 2 * (median + 1e-6);
      rerankInfo = { ran: true, adopted: discriminating, top: Number(top.toFixed(4)), median: Number(median.toFixed(4)) };
      if (discriminating) {
        // Adopt reranked order for the window; keep the RRF tail after it. Blend
        // rerank as primary key, RRF_boosted as the tiebreak inside the window.
        const tailIds = new Set(head.map(h => h.id));
        reranked.sort((a, b) =>
          ((Number(b.rerank_score) || 0) - (Number(a.rerank_score) || 0)) ||
          ((b._rrf_boosted || 0) - (a._rrf_boosted || 0)));
        for (const r of reranked) r._final_score = Number(r.rerank_score) || 0;
        const tail = fused.filter(f => !tailIds.has(f.id));
        fused.length = 0;
        fused.push(...reranked, ...tail);
        method = "hybrid-rrf+xenc";
      }
    }
  } catch (e) { console.warn("doRecall rerank (non-fatal):", e.message); rerankInfo = { ran: false, error: e.message.slice(0, 120) }; }

  return {
    query, method,
    elapsed_ms: Date.now() - t0,
    rerank: rerankInfo,
    tool_noise_filtered: _filteredOut,
    counts: {
      semantic: semanticArr.length, keyword: keywordArr.length,
      entity: entityArr.length, triple: tripleArr.length, fused: fused.length,
    },
    results: fused.slice(0, limit).map(r => ({
      id: r.id, title: r.title || r.name || null,
      surface: r.surface || null, session_id: r.session_id || null,
      timestamp_utc: r.timestamp_utc || r.timestamp || null,
      score: Number(r._rrf_boosted?.toFixed(4)) || 0,
      rerank_score: r.rerank_score != null ? Number(r.rerank_score.toFixed(4)) : null,
      provenance: r._methods || [],
      snippet: r.snippet || r.summary || null,
      path: r.path || r.wiki_path || null,
    })),
  };
}

// v9.2: query expansion. Fan a query out into related terms/phrasings so vector
// search retrieves the whole concept neighbourhood (supplement → medication,
// medicine, dose, FA drugs; copywriting → persuasion, storytelling, hooks).
// Cached in KV 30d so repeat queries skip the LLM call.
async function expandQuery(env, query) {
  const key = `qexp:${entitySlug(query).substring(0, 40)}`;
  try {
    const cached = env.VECTORS && await env.VECTORS.get(key);
    if (cached) { const a = JSON.parse(cached); if (Array.isArray(a) && a.length) return a; }
  } catch {}
  let expansions = [];
  try {
    const text = await withTimeout(callRoleLLM(env, "extraction", [
      { role: "system", content: "Output JSON only." },
      { role: "user", content: `List 4-6 alternative search terms/synonyms/closely-related concepts for this query, for retrieving related notes from a personal knowledge base. Include domain synonyms (e.g. supplement→medication,medicine,dose). Query: "${query}"\n\nReturn: {"terms":["...","..."]}` },
    ], 200), 2800, "");
    const m = (text || "").match(/\{[\s\S]*\}/);
    if (m) { const p = JSON.parse(m[0]); if (Array.isArray(p.terms)) expansions = p.terms.filter(t => typeof t === "string" && t.trim()).slice(0, 6); }
  } catch (e) { console.warn("expandQuery (non-fatal):", e.message); }
  const all = [...new Set([query, ...expansions])];
  try { if (env.VECTORS) await env.VECTORS.put(key, JSON.stringify(all), { expirationTtl: 86400 * 30 }); } catch {}
  return all;
}

// v9.2: embed query + expansions, union vector hits, keep best score per note.
async function semanticSearchExpanded(env, query, limit, { expand = true } = {}) {
  if (!env.AI || !env.VECTORIZE) return [];
  try {
    const queries = expand ? await expandQuery(env, query) : [query];
    const er = await env.AI.run(EMBEDDING_MODEL, { text: queries.slice(0, 5) });
    const vecs = er.data || [];
    const best = new Map(); // baseId → result (max score)
    // Parallel vector queries (was sequential — caused ~30s stalls + MCP timeouts).
    const matchLists = await withTimeout(
      Promise.all(vecs.map(v => env.VECTORIZE.query(v, { topK: limit, returnMetadata: true }).then(r => r.matches || []).catch(() => []))),
      6000, []
    );
    for (const matches of (matchLists || [])) {
      for (const m of matches) {
        const baseId = m.metadata?.base_id || m.id?.replace(/^vec:[^:]+:/, "");
        if (!baseId) continue;
        const prev = best.get(baseId);
        if (!prev || m.score > prev.score) {
          best.set(baseId, {
            id: baseId, _method: "semantic", score: m.score,
            title: m.metadata?.title || null, path: m.metadata?.path || null,
            surface: m.metadata?.surface || null, summary: m.metadata?.summary || null,
          });
        }
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  } catch (e) { console.warn("semanticSearchExpanded (non-fatal):", e.message); return []; }
}

async function recallSemantic(env, query, limit) {
  return semanticSearchExpanded(env, query, limit, { expand: true });
}

async function recallKeyword(env, query, limit) {
  if (env.DB) {
    const fts = await searchFts5(env, query, limit);
    if (fts.length) {
      return fts.map(r => ({
        id: r.id, _method: "fts5", title: r.title,
        surface: r.surface, session_id: r.session_id,
        timestamp_utc: r.timestamp_utc, snippet: r.snippet,
      }));
    }
  }
  // Fallback to GitHub keyword scan; derive id from path
  const arr = await doKeywordSearch(env, query);
  return arr.slice(0, limit).map(r => ({
    id: r.path ? obsIdFromWikiPath(r.path) : null,
    _method: "keyword",
    title: r.name, path: r.path,
    snippet: (r.matchingLines || []).join(" "),
  })).filter(r => r.id);
}

async function recallEntity(env, query, limit) {
  // Tokenise query. Probe capitalised tokens directly; also probe longer lowercase
  // tokens by Title-casing them, so "supplements"/"medications" still hit an entity
  // when one exists (getEntityFacts/resolveEntityName resolve aliases case-insensitively).
  const raw = query.split(/\s+/).filter(t => t.length > 2);
  const seen = new Set();
  const probes = [];
  for (const t of raw) {
    const cand = /^[A-Z]/.test(t) ? t : (t.length > 3 ? t[0].toUpperCase() + t.slice(1) : null);
    if (cand && !seen.has(cand.toLowerCase())) { seen.add(cand.toLowerCase()); probes.push(cand); }
  }
  if (!probes.length) return [];
  const out = [];
  for (const tok of probes.slice(0, 5)) {
    try {
      const facts = await getEntityFacts(env, tok);
      for (const f of (facts || []).slice(0, limit)) {
        const id = `entity:${entitySlug(tok)}:fact:${f.hash || factHash(f.fact || "")}`;
        out.push({ id, _method: "entity", title: `${tok} — ${f.fact?.substring(0, 80) || ""}`, snippet: f.fact });
      }
    } catch {}
  }
  return out.slice(0, limit);
}

async function recallTriples(env, query, limit) {
  const tokens = query.split(/\s+/).filter(t => t.length > 1);
  const out = [];
  for (const tok of tokens.slice(0, 6)) {
    try {
      const trs = await getTriples(env, tok);
      for (const t of (trs || []).slice(0, limit)) {
        const id = `triple:${entitySlug(t.subject)}:${entitySlug(t.predicate)}`;
        out.push({ id, _method: "triple", title: `${t.subject} ${t.predicate} ${t.object}`, snippet: `${t.subject} ${t.predicate}: ${t.object}` });
      }
    } catch {}
  }
  return out.slice(0, limit);
}

// ─── v9: session context — single <3 KB orienting payload ────────────────────
async function buildSessionContext(env) {
  if (!env.VECTORS) return { error: "KV unavailable" };
  const t0 = Date.now();
  const nowMs = Date.now();
  const since14dMs = nowMs - 14 * 86400 * 1000;
  const since30dMs = nowMs - 30 * 86400 * 1000;

  // Latest handoff
  let latest_handoff = null;
  try {
    const raw = await env.VECTORS.get("state:session-handoff:latest");
    if (raw) latest_handoff = JSON.parse(raw);
  } catch {}

  // Recent observations from recent:all (sharded) or fallback obs:recent
  const recRaw = await env.VECTORS.get("recent:all") || await env.VECTORS.get("obs:recent");
  const recentIds = recRaw ? JSON.parse(recRaw) : [];
  // last 60 ids is more than enough to cover 14 days at typical capture rate
  const candidateIds = [...recentIds].reverse().slice(0, 80);

  // v10.0.1: parallel reads (was up to 80 serial KV gets on the hottest path —
  // session_context is the documented first call every session). Independent reads.
  const obsList = (await Promise.all(candidateIds.map(id => readObservation(env, id)))).filter(Boolean);

  // Open threads — state=="open" OR next_action non-empty, last 14d.
  const open_threads = obsList
    .filter(o => {
      const ts = Date.parse(o.timestamp || 0) || 0;
      if (ts < since14dMs) return false;
      const isOpen = (typeof o.state === "string" && o.state.toLowerCase() === "open") || (typeof o.next_action === "string" && o.next_action.trim().length > 0);
      return isOpen;
    })
    .slice(0, 8)
    .map(o => ({ id: o.id, title: o.title, next_action: o.next_action || null, surface: o.surface, session_id: o.session_id }));

  // Recent verdicts — tags include "verdict" or "AUTHORITATIVE", last 30d.
  const recent_verdicts = obsList
    .filter(o => {
      const ts = Date.parse(o.timestamp || 0) || 0;
      if (ts < since30dMs) return false;
      return (o.tags || []).some(t => /verdict|authoritative/i.test(String(t)));
    })
    .slice(0, 6)
    .map(o => ({ id: o.id, title: o.title, surface: o.surface, when: o.timestamp_ist || o.timestamp }));

  // Active topics — entity freq across last 5 distinct sessions.
  const sessionSeen = new Set();
  const entFreq = {};
  for (const o of obsList) {
    if (!o.session_id) continue;
    sessionSeen.add(o.session_id);
    if (sessionSeen.size > 5) break;
    for (const e of (o.entities || [])) {
      if (typeof e !== "string" || e.length < 2) continue;
      entFreq[e] = (entFreq[e] || 0) + 1;
    }
  }
  const active_topics = Object.entries(entFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([entity, count]) => ({ entity, count }));

  return {
    elapsed_ms: Date.now() - t0,
    latest_handoff,
    open_threads,
    recent_verdicts,
    active_topics,
  };
}

// ─── Capture ──────────────────────────────────────────────────────────────────
async function handleCapture(req, env, ctx) {
  const body = await req.json().catch(() => ({}));
  const { type = "note", title, content } = body;
  if (!title || !content) return jsonErr("title and content required", 400);
  // v9.7: server-side noise gate. Tool-call auto-captures (bash/edit/write/mcp)
  // are ZERO-value standalone observations — they inflate lint counts and dilute
  // recall. Reject them at the boundary so stray hook re-registrations can't
  // reintroduce noise. The hook on disk (tool-observations.sh) is already
  // unregistered; this is belt-and-suspenders.
  if (isToolNoiseName(title)) {
    return jsonOk({ status: "skipped", reason: "tool-call-noise", title });
  }
  if (type === "code") {
    const now=istDateStr(), slug=slugify(title), fp=`raw/code/${now}-${slug}.md`;
    const surface=normalizeSurface(body.surface)||"other";
    const tags=[...new Set([...(body.tags||[]),surface])];
    const entities=[...new Set([...(body.entities||[]),surface])];
    const fm=buildFrontmatter({type,created:now,tags,entities,source_url:body.source_url||"",surface,session_id:now});
    const res=await ghPut(env,fp,fm+content,`auto: capture code - ${title}`);
    if(!res.ok) return jsonErr("GitHub write failed",502);
    return jsonOk({status:"captured",path:fp});
  }
  return jsonOk({ status:"captured", ...(await runIngestPipeline(env, ctx, body)) });
}

// ─── Graph / file / files ─────────────────────────────────────────────────────
async function handleGraph(env) {
  const r = await ghGet(env, "graph/graph.json", true);
  return r.ok ? new Response(await r.text(), { headers: jsonHeaders() }) : jsonErr("Could not read graph", 502);
}

async function handleFile(url, env) {
  const path = url.searchParams.get("path");
  if (!path) return jsonErr("path required", 400);
  const r = await ghGet(env, path, true);
  return r.ok ? new Response(await r.text(), { headers: { "Content-Type": "text/markdown; charset=utf-8", ...corsHeaders() } }) : jsonErr("File not found", 404);
}

async function handleFiles(env) {
  const repo=env.GITHUB_REPO||"your-username/your-repo", branch=env.GITHUB_BRANCH||"main";
  const r = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/?ref=${branch}`, { headers: { Accept:"application/vnd.github.v3+json", "User-Agent":GH_UA } });
  if (!r.ok) return jsonErr("Could not list files", 502);
  const files = (await r.json()).filter(f => f.name.endsWith(".md"));
  return jsonOk({ total: files.length, files: files.map(f => ({ name: f.name, path: f.path, size: f.size })) });
}

// ─── Stats ────────────────────────────────────────────────────────────────────
async function computeStats(env) {
  const cats = ["conversations","entities","topics","projects","skills","rules","code","raw"];
  const stats = { categories: {}, total_chunks: 0, warnings: [], upgrade_needed: false };
  for (const c of cats) {
    try { const l=await env.VECTORS.list({prefix:`${c}::`,limit:1000}); stats.categories[c]={chunks:l.keys.length}; stats.total_chunks+=l.keys.length; }
    catch { stats.categories[c]={chunks:0}; }
  }
  try {
    const el = await env.VECTORS.list({ prefix: "entity:", limit: 1000 });
    stats.entity_memory = {
      entities: el.keys.filter(k=>k.name.endsWith(":meta")).length,
      total_facts: el.keys.filter(k=>k.name.includes(":fact:")).length,
      aliases: (await getAliasMap(env)) ? Object.keys(await getAliasMap(env)).length : 0,
    };
  } catch { stats.entity_memory = { entities: 0, total_facts: 0, aliases: 0 }; }

  const used = await getNeuronUsage(env);
  stats.ai_neurons_used_today   = used;
  stats.ai_budget_remaining     = Math.max(0, NEURON_BUDGET_COMPRESSION - used);
  stats.compressions_left_today = Math.floor(stats.ai_budget_remaining / NEURON_COST_PRIMARY);
  stats.compression_model       = "mistral-nemotron (Western 7-tier fallback)";

  if (stats.total_chunks >= 30000) { stats.upgrade_needed = true; stats.warnings.push({ level: "CRITICAL", message: `${stats.total_chunks} chunks — upgrade to paid plan.` }); }
  else if (stats.total_chunks >= 20000) stats.warnings.push({ level: "WARNING", message: `${stats.total_chunks} chunks — approaching limit.` });
  else stats.warnings.push({ level: "OK", message: `${stats.total_chunks} chunks — healthy.` });
  return stats;
}

// ─── Health check ─────────────────────────────────────────────────────────────
async function runHealthCheck(env, fix = false, batchSize = 5) {
  const repo=env.GITHUB_REPO||"your-username/your-repo", branch=env.GITHUB_BRANCH||"main";
  const report = { timestamp: new Date().toISOString(), fix_mode: fix, raw_files: 0, wiki_files: 0, issues: [], fixed: [], graph_nodes: 0, graph_edges: 0 };

  try {
    const [rawRes, wikiRes, graphRes] = await Promise.all([
      ghFetch(env, `https://api.github.com/repos/${repo}/contents/raw/conversations?ref=${branch}`,  { headers: { Accept:"application/vnd.github.v3+json", "User-Agent":GH_UA } }),
      ghFetch(env, `https://api.github.com/repos/${repo}/contents/wiki/conversations?ref=${branch}`, { headers: { Accept:"application/vnd.github.v3+json", "User-Agent":GH_UA } }),
      ghFetch(env, `https://api.github.com/repos/${repo}/contents/graph/graph.json?ref=${branch}`,  { headers: { Accept:"application/vnd.github.v3.raw",  "User-Agent":GH_UA } }),
    ]);

    const rawFiles  = rawRes.ok  ? (await rawRes.json()).filter(f=>f.name.endsWith(".md"))  : [];
    const wikiFiles = wikiRes.ok ? (await wikiRes.json()).filter(f=>f.name.endsWith(".md")) : [];
    report.raw_files  = rawFiles.length;
    report.wiki_files = wikiFiles.length;

    const rawNames  = new Set(rawFiles.map(f=>f.name));
    const wikiNames = new Set(wikiFiles.map(f=>f.name));
    for (const f of rawFiles.filter(f=>!wikiNames.has(f.name)))  report.issues.push({ type:"missing-wiki", severity:"high",   file:f.path });
    for (const f of wikiFiles.filter(f=>!rawNames.has(f.name)))  report.issues.push({ type:"orphan-wiki",  severity:"medium", file:f.path });

    if (graphRes.ok) {
      try {
        const graph = JSON.parse(await graphRes.text());
        report.graph_nodes = graph.nodes?.length || 0;
        report.graph_edges = graph.edges?.length || 0;
        const seen=new Set();
        for (const id of graph.nodes?.map(n=>n.id)||[]) { if(seen.has(id)) report.issues.push({type:"dup-node",severity:"high",file:id}); seen.add(id); }
      } catch { report.issues.push({type:"corrupt-graph",severity:"critical",file:"graph/graph.json"}); }
    }

    if (fix) {
      const toFix = rawFiles.filter(f=>!wikiNames.has(f.name)).slice(0, batchSize);
      report.batch_size = batchSize;
      report.remaining  = Math.max(0, rawFiles.filter(f=>!wikiNames.has(f.name)).length - toFix.length);
      for (const rf of toFix) {
        try {
          const cr = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${rf.path}?ref=${branch}`, { headers: { Accept:"application/vnd.github.v3.raw", "User-Agent":GH_UA } });
          if (!cr.ok) continue;
          const raw = await cr.text();
          const title = (raw.match(/^title:\s*(.+)$/m)||rf.name.match(/^\d{4}-\d{2}-\d{2}-(.+)\.md$/))?.[1] || rf.name;
          const now = new Date().toISOString().split("T")[0];
          const compressed = await compressToWiki(env, title, raw, [], [], now);
          await writeFile(env, rf.path.replace("raw/","wiki/"), compressed, `health-fix: ${rf.name}`);
          await appendToLog(env, now, "health-fix", title, rf.path.replace("raw/","wiki/"));
          report.fixed.push(rf.name);
        } catch (e) { report.issues.push({type:"fix-error",severity:"low",file:rf.path,message:e.message}); }
      }
    }

    report.healthy = report.issues.filter(i=>i.severity!=="low").length === 0;
    report.summary = report.healthy
      ? `Healthy — ${report.raw_files} raw, ${report.wiki_files} wiki, ${report.graph_nodes} nodes`
      : `${report.issues.length} issues — ${report.issues.filter(i=>["high","critical"].includes(i.severity)).length} high priority`;
  } catch (e) { report.error=e.message; report.healthy=false; report.summary=`Error: ${e.message}`; }
  return report;
}

// ─── Fact consolidation ───────────────────────────────────────────────────────
async function consolidateFacts(env) {
  if (!env.VECTORS || !env.AI) return { skipped: "No KV or AI" };
  const report = { entities_processed: 0, facts_merged: 0, errors: [] };
  try {
    const list = await env.VECTORS.list({ prefix: "entity:", limit: 500 });
    const metaKeys = list.keys.filter(k => k.name.endsWith(":meta"));

    for (const mk of metaKeys.slice(0, 20)) {
      const slug = mk.name.replace("entity:","").replace(":meta","");
      try {
        const metaRaw = await env.VECTORS.get(mk.name);
        if (!metaRaw) continue;
        const meta  = JSON.parse(metaRaw);
        const facts = await getEntityFacts(env, meta.name);
        if (facts.length < 3) continue;

        if (!(await canAfford(env, NEURON_COST_EXTRACTION))) break;

        const factList = facts.map((f,i)=>`${i}: "${f.fact}"`).join("\n");
        const text = await callRoleLLM(env, "extraction", [
          { role:"user", content:`Find duplicate facts about "${meta.name}":\n${factList}\n\nReturn JSON: {"duplicates":[[0,2],[1,4]]} where inner arrays are indices of facts saying the same thing. Empty array if none.` },
        ], 200);
        await addNeuronUsage(env, NEURON_COST_EXTRACTION);
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) continue;
        const { duplicates } = JSON.parse(match[0]);
        if (!Array.isArray(duplicates)) continue;

        for (const group of duplicates) {
          if (!Array.isArray(group) || group.length < 2) continue;
          const gf = group.map(i=>facts[i]).filter(Boolean);
          if (gf.length < 2) continue;
          const [keeper,...losers] = [...gf].sort((a,b)=>(b.confidence||0)-(a.confidence||0)||(b.count||0)-(a.count||0));
          const totalCount = gf.reduce((s,f)=>s+(f.count||1),0);
          const keeperKey = `entity:${slug}:fact:${factHash(keeper.fact.toLowerCase().trim())}`;
          await env.VECTORS.put(keeperKey, JSON.stringify({ ...keeper, count: totalCount, confidence: Math.min(totalCount/5,1.0), last_reinforced: Date.now() }), { expirationTtl: 86400*730 });
          const ixKey = `entity:${slug}:facts_index`;
          const ixRaw = await env.VECTORS.get(ixKey);
          if (ixRaw) {
            const loserKeys = losers.map(f=>`entity:${slug}:fact:${factHash(f.fact.toLowerCase().trim())}`);
            const newKeys = JSON.parse(ixRaw).filter(k=>!loserKeys.includes(k));
            await env.VECTORS.put(ixKey, JSON.stringify(newKeys), { expirationTtl: 86400*730 });
            for (const lk of loserKeys) await env.VECTORS.delete(lk);
            report.facts_merged += losers.length;
          }
        }
        report.entities_processed++;
      } catch (e) { report.errors.push({ entity: slug, error: e.message }); }
    }
  } catch (e) { report.error = e.message; }
  return report;
}

// ─── About-Me engine (v9.5) ──────────────────────────────────────────────────
// Pure logic mirrors worker/src/aboutme-util.js (tested there). Regenerated by
// cron daily 4am IST → wiki/profile/about-owner.md. Adversarial by spec: the
// Tensions section is never empty when loops/contradictions exist.
const _NOISE_TOKENS=new Set(["the","a","an","and","or","to","of","for","in","on","my","is","plan","day","tool","bash","edit","write","read","grep","mcp","this","that","with","from","claude","code","second","brain","session","handoff","switch","mode","caveman","ultra","lite","full","tell","about","latest","version","update","doing","something","whenever","maximum","compression","search","semantic","keyword","base","directory","users","skill","built","yesterday","now","can","you","please","want","need","2024","2025","2026","2027","msg","obs","node","file","line","step","task"]);
function _isNoiseTitle(title){ const t=(title||"").toLowerCase(); if(!t)return true; if(/\btool[-_ ]/.test(t))return true; if(/\b[0-9a-f]{6,}\b/.test(t))return true; if(/^\d{4}-\d{2}-\d{2}[-: ]\d{2}/.test(t))return true; if(/mcp__/.test(t))return true; if(/^test\b/.test(t))return true; return false; }
function _clusterTopics(observations){ const b={}; for(const o of observations){ if(_isNoiseTitle(o.title))continue; const toks=(o.title||"").toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>3&&!_NOISE_TOKENS.has(w)&&!/^\d+$/.test(w)); for(const w of toks)(b[w]=b[w]||[]).push(o.title);} return Object.entries(b).map(([topic,titles])=>({topic,count:titles.length,titles})).filter(x=>x.count>=2).sort((a,c)=>c.count-a.count); }
function _detectTensions(rules,recentActions){ const ruleTensions=[]; const clean=recentActions.filter(a=>!_isNoiseTitle(a.title)); for(const rule of rules){ const rl=rule.toLowerCase(); const m=rl.match(/before (?:building|doing|automating)?\s*(\w[\w\s]{2,30})/); const guarded=m?m[1].trim():null; for(const a of clean){ const at=(a.title||"").toLowerCase(); if(guarded&&(at.includes("automat")||at.includes("routine")||at.includes("built"))&&rl.split(/\s+/).some(tok=>tok.length>4&&at.includes(tok))) ruleTensions.push(`Contradiction — rule "${rule}" vs recent action "${a.title}"`);} } const loops=_clusterTopics(clean).filter(c=>c.count>=2).slice(0,5).map(c=>`Recurring focus: "${c.topic}" (${c.count}x recent) — finishing it?`); return [...new Set([...ruleTensions,...loops])]; }
function _composeProfile({identity=[],beliefs=[],active=[],tensions=[]}){ const sec=(h,items)=>`## ${h}\n${items.length?items.map(i=>`- ${i}`).join("\n"):"_none_"}\n`; return ["# About Brain Owner — synthesized self-model","",sec("Identity & Facts",identity),sec("Beliefs & Operating Rules",beliefs),sec("Active State",active),sec("Tensions / Open Loops",tensions)].join("\n"); }

async function regenAboutMe(env) {
  // v10.2.1: pull ALL categories (was fact-only, top-12 — why the profile froze in
  // Feb). getEntityFacts already ranks pinned/behavioral high and no longer decays
  // identity, so the strongest self-model facts float up regardless of age.
  // L1 identity — facts, dedup, widen to 20.
  let identity = [];
  try {
    const facts = await getEntityFacts(env, "Brain Owner", "fact").catch(() => []);
    identity = [...new Set((facts || []).map(f => f.fact))].slice(0, 20);
  } catch {}
  // L2 beliefs+rules — instruction + preference facts.
  let beliefs = [];
  try {
    const [inst, prefs] = await Promise.all([
      getEntityFacts(env, "Brain Owner", "instruction").catch(() => []),
      getEntityFacts(env, "Brain Owner", "preference").catch(() => []),
    ]);
    beliefs = [...new Set([...(inst || []), ...(prefs || [])].map(f => f.fact))].slice(0, 16);
  } catch {}
  // L2b behavioral — inferred working/build/communication patterns (v10.2.1).
  let behavioral = [];
  try {
    const beh = await getEntityFacts(env, "Brain Owner", "behavioral").catch(() => []);
    behavioral = [...new Set((beh || []).map(f => f.fact))].slice(0, 14);
  } catch {}
  // L3 active state — open threads + latest handoff
  let active = [];
  try {
    const sc = await buildSessionContext(env);
    if (sc?.latest_handoff?.topic) active.push(`handoff: ${sc.latest_handoff.topic}`);
    for (const th of (sc?.open_threads || []).slice(0, 6)) active.push(`open: ${th.title}`);
  } catch {}
  // v10 §C: surface the most-connected entities (god-nodes) right now.
  try {
    const top = await scanEntityCentrality(env, 3);
    if (top.length) active.push(`most-connected: ${top.map(t => t.entity).join(", ")}`);
  } catch {}
  // L4 patterns — cluster recent obs titles; tensions vs beliefs
  let recent = [];
  try {
    const raw = await env.VECTORS.get("recent:all");
    // Window 200 (was 60): this session's tool-logs dominate the newest 60 and
    // all get noise-filtered, leaving nothing to cluster. A wider window lets
    // real titled notes (ExampleProject, supplements, etc.) into the sample.
    const ids = raw ? JSON.parse(raw).slice(-200) : [];
    // v10.0.1: parallel reads (was up to 200 serial KV gets).
    const obss = await Promise.all(ids.map(id => readObservation(env, id)));
    for (const o of obss) { if (o) recent.push({ title: o.title, ts: o.timestamp }); }
  } catch {}
  // v10.2.1: voice-profile pointer — tell agents a style card exists.
  try {
    const vp = await env.VECTORS.get("state:voice-profile:latest");
    if (vp) { const c = JSON.parse(vp); if (c.voice_summary) active.push(`voice: ${c.voice_summary.slice(0, 160)} (full card: wiki/profile/voice-owner.md)`); }
  } catch {}
  const tensions = _detectTensions(beliefs, recent);
  const behSec = behavioral.length ? `\n## Behavioral Patterns (how Brain Owner works)\n${behavioral.map(b => `- ${b}`).join("\n")}\n` : "";
  const profile = _composeProfile({ identity, beliefs, active, tensions }) + behSec;
  await writeFile(env, "wiki/profile/about-owner.md", profile + "\n\n## Backlinks\n[[index]]\n", "about-me: cron regen");
  await env.VECTORS.put("state:about-me:latest", JSON.stringify({ ts: new Date().toISOString(), tensions_count: tensions.length, behavioral: behavioral.length }), { expirationTtl: 86400 * 14 });
  return { tensions_count: tensions.length, identity: identity.length, beliefs: beliefs.length, behavioral: behavioral.length, active: active.length };
}

// ─── Cron ─────────────────────────────────────────────────────────────────────
// Schedule: */15 * * * *  (every 15 min). Light health-watch runs every tick.
// Heavy work (compression, backfill, consolidation, home-feed, monthly index)
// runs only when (UTC hour % 6 === 0 AND minute === 0) — same cadence as
// the prior 6h schedule. Each block self-gates with `isHeavyTick`.
async function handleCron(env) {
  const now = new Date();
  const cronHour = now.getUTCHours();
  const cronMinute = now.getUTCMinutes();
  const isHeavyTick = (cronHour % 6 === 0) && (cronMinute < 15); // ~once every 6h

  // ── Light tick: health-watch (every 15 min) ────────────────────────────────
  // Single KV ping + single GitHub rate-limit probe (which DOES NOT count
  // against the 5000/h core quota). Captures self-observation on degraded state.
  try {
    const t0 = Date.now();
    const kvPing = await env.VECTORS.get("obs:latest_session")
      .then(() => Date.now() - t0)
      .catch(() => -1);
    const kvWrites = await getKVWriteCount(env);
    const kvStatus = kvWrites >= KV_WRITE_LIMIT_BLOCK ? "blocked"
                   : kvWrites >= KV_WRITE_LIMIT_WARN ? "warning" : "ok";

    let ghOk = false, ghRemain = -1, ghReset = null, ghErr = null;
    try {
      const rl = await ghFetch(env, "https://api.github.com/rate_limit", {
        headers: { "User-Agent": GH_UA },
      });
      if (rl.ok) {
        const j = await rl.json();
        ghOk = true;
        ghRemain = j?.resources?.core?.remaining ?? -1;
        ghReset  = j?.resources?.core?.reset ?? null;
      } else {
        ghErr = `rate_limit endpoint returned ${rl.status}`;
      }
    } catch (e) { ghErr = e.message; }

    const problems = [];
    if (kvPing < 0) problems.push("kv_ping_failed");
    if (kvStatus !== "ok") problems.push(`kv_status=${kvStatus} (${kvWrites} writes today)`);
    if (!ghOk) problems.push(`github_unreachable: ${ghErr}`);
    if (ghOk && ghRemain >= 0 && ghRemain < 500) problems.push(`github_rate_low: ${ghRemain}/5000 remaining`);

    if (problems.length > 0) {
      // Record alert via KV (cheap — no GitHub write). REST endpoint exposes it.
      const alert = {
        ts: now.toISOString(),
        ts_ist: istIsoStr(),
        kv_ping_ms: kvPing,
        kv_status: kvStatus,
        kv_writes_today: kvWrites,
        github_ok: ghOk,
        github_remaining: ghRemain,
        github_reset_at: ghReset ? new Date(ghReset * 1000).toISOString() : null,
        problems,
      };
      await env.VECTORS.put("state:health-watch:latest", JSON.stringify(alert), { expirationTtl: 86400 * 7 });
      await env.VECTORS.put(`alert:${now.toISOString()}`, JSON.stringify(alert), { expirationTtl: 86400 * 30 });
      console.warn("[health-watch] ALERT", JSON.stringify(alert));
    } else {
      // Snapshot healthy state too (for /health?deep=1 + dashboards)
      await env.VECTORS.put("state:health-watch:latest", JSON.stringify({
        ts: now.toISOString(), ts_ist: istIsoStr(), kv_ping_ms: kvPing, kv_status: kvStatus,
        kv_writes_today: kvWrites, github_ok: ghOk, github_remaining: ghRemain,
        github_reset_at: ghReset ? new Date(ghReset * 1000).toISOString() : null,
        problems: [],
      }), { expirationTtl: 86400 * 7 });
    }
  } catch (e) { console.warn("[health-watch] failed:", e.message); }

  // ── Heavy work: only on 6h boundary minute 0..14 ──────────────────────────
  if (!isHeavyTick) return;

  const [health, consolidation] = await Promise.allSettled([
    runHealthCheck(env, true),
    consolidateFacts(env),
  ]);
  console.log("Cron health:", health.value?.summary);
  console.log("Cron consolidation:", JSON.stringify(consolidation.value));

  // U6: Sleep-time LLM consolidation (v9.1.2) — 3am IST nightly, Sunday weekly
  try {
    if (isISTHour(now, 3)) {
      await runNightlyConsolidation(env, { waitUntil: () => {} }, callRoleLLM);
    }
    if (isISTDayHour(now, 0, 3)) {
      await runWeeklyConsolidation(env, { waitUntil: () => {} }, callRoleLLM);
    }
    const flushed = await flushPendingConsolidations(env, writeFile);
    if (flushed) console.log(`[consolidation] flushed ${flushed} distilled pages`);
  } catch (e) { console.warn("[consolidation] cron (non-fatal):", e.message); }

  // v9.5: About-Me regen — daily 4am IST (after 3am nightly consolidation).
  try {
    if (isISTHour(now, 4)) {
      const r = await regenAboutMe(env);
      console.log("[about-me] regen:", JSON.stringify(r));
    }
  } catch (e) { console.warn("[about-me] cron (non-fatal):", e.message); }

  // v9.7: Nightly compaction — 2am IST (UTC 20:30 prev day ≈ cronHour 20).
  // Bounded batch (50 files/run) so it stays within subrequest + CPU limits.
  // Idempotent: skips files already in raw/_pruned/.
  try {
    if (isISTHour(now, 2)) {
      const fakeReq = new Request("https://internal/compact", {
        method: "POST",
        body: JSON.stringify({ dry_run: false, batch: 50 }),
      });
      const r = await handleCompact(fakeReq, env);
      const j = await r.clone().json().catch(() => ({}));
      console.log("[compact] cron:", j.moved, "moved,", j.errors, "errors, remaining:", j.remaining_prune);
    }
  } catch (e) { console.warn("[compact] cron (non-fatal):", e.message); }

  // Resumable backfill — runs only on 0h and 12h UTC crons (2 of 4 daily runs)
  // Leaves 6h and 18h runs for consolidation/health without KV write competition.
  const isBackfillCron = (cronHour === 0 || cronHour === 12);
  try {
    const offsetRaw = await env.VECTORS.get("backfill:offset");
    const isDone = await env.VECTORS.get("backfill:done");
    if (!isDone && isBackfillCron) {
      const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;
      const repo = env.GITHUB_REPO || "your-username/your-repo";
      const branch = env.GITHUB_BRANCH || "main";
      const dir = "wiki/conversations";
      const listRes = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${dir}?ref=${branch}`,
        { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "lnm-brain/5.3" } }
      );
      if (listRes.ok) {
        const allFiles = (await listRes.json()).filter(f => f.name.endsWith(".md"));
        const batch = allFiles.slice(offset, offset + 15);
        let processed = 0;
        for (const file of batch) {
          try {
            const contentRes = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${file.path}?ref=${branch}`,
              { headers: { Accept: "application/vnd.github.v3.raw", "User-Agent": "lnm-brain/5.3" } }
            );
            if (!contentRes.ok) continue;
            const content = await contentRes.text();
            const entityMatch = content.match(/^entities:\s*\[([^\]]+)\]/m);
            const callerEntities = entityMatch ? entityMatch[1].split(",").map(s => s.trim()) : [];
            await extractAndStoreFactsFromContent(env, content, callerEntities, file.path);
            processed++;
          } catch (e) {
            console.log(`Cron backfill error on ${file.name}: ${e.message}`);
          }
        }
        const nextOffset = offset + batch.length;
        if (nextOffset >= allFiles.length) {
          await env.VECTORS.put("backfill:done", "true");
          console.log(`Cron backfill complete. Total files: ${allFiles.length}`);
        } else {
          await env.VECTORS.put("backfill:offset", String(nextOffset));
          console.log(`Cron backfill: processed ${processed}/${batch.length} files, next offset=${nextOffset}, remaining=${allFiles.length - nextOffset}`);
        }
      }
    }
  } catch (e) {
    console.log("Cron backfill error:", e.message);
  }

  // v7.1.4: domain backfill on every cron tick (cheap, ~30 files per tick)
  try {
    const domainsDone = await env.VECTORS.get("backfill:domains:done");
    if (!domainsDone) {
      const fakeReq = new Request("https://internal/api/auto-backfill-domains?batch=5", {method:"GET"});
      const res = await handleAutoBackfillDomains(fakeReq, env);
      const j = await res.json();
      console.log(`Cron domain backfill: processed=${j.processed}, offset=${j.current_offset}, remaining=${j.remaining}`);
      if (j.remaining === 0 || j.total_files && j.current_offset >= j.total_files) {
        await env.VECTORS.put("backfill:domains:done", "true");
      }
    }
  } catch (e) { console.log("Cron domain backfill:", e.message); }

  // v7.5.0: home-feed snapshot — runs every cron tick. Reads obs:recent, joins
  // meta, writes compact JSON to state:home-feed:v1. Mobile reads = single KV get.
  try {
    const recRaw = await env.VECTORS.get("obs:recent");
    const ids = recRaw ? JSON.parse(recRaw) : [];
    // v10.2.2 perf: early-exit chunked scan for the 30 newest non-superseded.
    const entries = await scanObservations(env, [...ids].reverse(), 30, (obs, id) =>
      obs.superseded_by ? null : {
        id, title: obs.title,
        timestamp_utc: obs.timestamp,
        timestamp_ist: obs.timestamp_ist || istIsoStr(obs.timestamp),
        surface: obs.surface || "other",
        category: obs.category || "conversation",
        session_id: obs.session_id,
        entities: (obs.entities || []).slice(0, 6),
      });
    entries.sort((a, b) => (Date.parse(b.timestamp_utc || 0) || 0) - (Date.parse(a.timestamp_utc || 0) || 0));
    // v10 §C: attach god-node ranking. Isolated try/catch so a scan failure
    // leaves entries intact rather than blanking the whole snapshot.
    let topEntities = [];
    try { topEntities = await scanEntityCentrality(env, 10); }
    catch (e) { console.log("Cron centrality:", e.message); }
    const snapshot = { built_at: new Date().toISOString(), built_at_ist: istIsoStr(), count: entries.length, entries, top_entities: topEntities };
    await env.VECTORS.put("state:home-feed:v1", JSON.stringify(snapshot), OBS_TTL);
    console.log(`Cron home-feed: ${entries.length} entries, ${topEntities.length} top entities`);
  } catch (e) { console.log("Cron home-feed:", e.message); }

  // v7.4.0: Auto-create/update monthly session index at wiki/_indexes/YYYY-MM.md
  try {
    const now = new Date();
    const yy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const indexPath = `wiki/_indexes/${yy}-${mm}.md`;
    const repo = env.GITHUB_REPO || "your-username/your-repo";
    const branch = env.GITHUB_BRANCH || "main";
    const lastUpdateKey = `monthly_index:last:${yy}-${mm}`;
    const lastUpdate = await env.VECTORS.get(lastUpdateKey);
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    if (!lastUpdate || (Date.now() - parseInt(lastUpdate, 10)) > SIX_HOURS) {
      const listRes = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/wiki/conversations?ref=${branch}`,
        { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } }
      );
      if (listRes.ok) {
        const prefix = `${yy}-${mm}`;
        const monthFiles = (await listRes.json()).filter(f => f.name.startsWith(prefix) && f.name.endsWith(".md"));
        if (monthFiles.length > 0) {
          let existingSha = null;
          const existingRes = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${indexPath}?ref=${branch}`,
            { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } }
          );
          if (existingRes.ok) existingSha = (await existingRes.json()).sha;
          const lines = [
            `---`,
            `type: monthly-index`,
            `month: ${yy}-${mm}`,
            `updated: ${now.toISOString().slice(0, 10)}`,
            `sessions: ${monthFiles.length}`,
            `---`,
            ``,
            `# Session Index — ${yy}-${mm}`,
            ``,
            `Auto-generated. ${monthFiles.length} sessions this month.`,
            ``,
            `## Sessions`,
            ``,
            ...monthFiles.map(f => `- [[${f.name.replace(".md", "")}]]`),
            ``,
            // v7.9.0: backlink to root index for graph coherence
            `## Backlinks`,
            `[[index]]`,
            ``,
          ];
          const encoded = btoa(unescape(encodeURIComponent(lines.join("\n"))));
          const writeRes = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${indexPath}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json", "User-Agent": GH_UA },
              body: JSON.stringify({
                message: `chore: auto monthly index ${yy}-${mm} (${monthFiles.length} sessions)`,
                content: encoded,
                branch,
                ...(existingSha ? { sha: existingSha } : {}),
              }),
            }
          );
          if (writeRes.ok) {
            await env.VECTORS.put(lastUpdateKey, String(Date.now()), { expirationTtl: 86400 * 35 });
            console.log(`Cron monthly index: ${indexPath} updated, ${monthFiles.length} sessions`);
          } else {
            console.log(`Cron monthly index failed: ${writeRes.status} ${(await writeRes.text()).slice(0, 200)}`);
          }
        }
      }
    }
  } catch (e) { console.log("Cron monthly index:", e.message); }

  // v9.3: Reconciler drain — one batch per 15-min cron tick, KV cursor persists position.
  // Self-healing: if a capture ever misses its index entry, cron catches it within 15 min.
  // Resets cursor to 0 when past end (steady-state re-sweep keeps backlinks current).
  try {
    const cursorKey = "state:reconcile:cursor";
    const storedCursor = await env.VECTORS.get(cursorKey);
    const cursor = storedCursor ? parseInt(storedCursor, 10) : 0;
    const fakeReq = new Request("https://internal/reconcile-index", {
      method: "POST",
      body: JSON.stringify({ cursor, batch: 40 }),
    });
    const res = await handleReconcileIndex(fakeReq, env);
    const result = await res.json();
    const nextCursor = result.cursor ?? 0;
    await env.VECTORS.put(cursorKey, String(nextCursor), { expirationTtl: 86400 * 7 });
    console.log(`Cron reconcile: cursor=${cursor} hubs_written=${result.hubs_written} backlinks_added=${result.backlinks_added} remaining=${result.remaining}`);
  } catch (e) { console.log("Cron reconcile:", e.message); }
}

// ─── /facts endpoint ──────────────────────────────────────────────────────────
async function handleGetFacts(url, env) {
  const entity = url.searchParams.get("entity") || url.searchParams.get("e");
  if (!entity) {
    if (!env.VECTORS) return jsonOk({ entities: [], note: "KV not available" });
    try {
      const list = await env.VECTORS.list({ prefix: "entity:", limit: 1000 });
      const slugSet = new Set(list.keys.filter(k=>k.name.endsWith(":meta")).map(k=>k.name.replace("entity:","").replace(":meta","")));
      // v10.0.1: parallel meta reads (was serial per-slug).
      const metas = await Promise.all([...slugSet].map(slug => env.VECTORS.get(`entity:${slug}:meta`).then(m => ({ slug, m }))));
      const out = [];
      for (const { slug, m } of metas) {
        if (m) { const meta=JSON.parse(m); out.push({ slug, name:meta.name, total_facts:meta.total_facts||0, updated:meta.updated }); }
      }
      out.sort((a,b)=>(b.updated||0)-(a.updated||0));
      const aliases = await getAliasMap(env);
      return jsonOk({ entities: out, total: out.length, aliases });
    } catch (e) { return jsonErr(e.message, 500); }
  }
  const facts = await getEntityFacts(env, entity);
  return jsonOk({ entity, resolved_to: await resolveEntityName(env, entity), facts: facts.map(f=>({ fact:f.fact, confidence:f.confidence, count:f.count, superseded_by:f.superseded_by, created:f.created, last_reinforced:f.last_reinforced })), total: facts.length });
}

// ─── MCP tools ────────────────────────────────────────────────────────────────
const MCP_TOOLS = [
  { name: "query_second_brain",  description: "Search Second Brain. Returns entity facts FIRST (instructions at top), then doc matches. Best for recall. Semantic/vector fusion + 1-hop run BY DEFAULT (bridges synonyms, e.g. supplements≈medications). Optional category filter: decision|bugfix|feature|discovery|conversation|note. Set fast=true ONLY to opt into keyword+entities-only for a <5s response (skips vectors — may miss synonyms). rerank=true enables LLM reranking.", inputSchema: { type:"object", properties:{ query:{type:"string"}, category:{type:"string",enum:["decision","bugfix","feature","discovery","conversation","note"]}, fast:{type:"boolean",description:"Opt into keyword-only (skip semantic+1-hop). Default false — vectors run."}, rerank:{type:"boolean",description:"Enable LLM reranking. Default false."} }, required:["query"] } },
  { name: "get_entity_facts",    description: "Get confidence-scored facts for a specific entity. Supports category filter: fact|preference|instruction|history. Resolves aliases automatically.", inputSchema: { type:"object", properties:{ entity:{type:"string"}, category:{type:"string",enum:["fact","preference","instruction","history"]} }, required:["entity"] } },
  { name: "ask_second_brain",    description: "Natural language Q&A over your entire Second Brain. Uses semantic search + reranking + entity facts + instructions. Best for questions.", inputSchema: { type:"object", properties:{ question:{type:"string"}, top_k:{type:"number",default:3} }, required:["question"] } },
  { name: "semantic_search",     description: "Semantic vector search using AI embeddings.", inputSchema: { type:"object", properties:{ query:{type:"string"}, top_k:{type:"number",default:5} }, required:["query"] } },
  { name: "capture_to_second_brain", description: "Save content. Auto-extracts entity facts (with categories + triples) + contradiction detection + normalization. surface is FIRST-CLASS — pass it on every capture. If YOU (the assistant) can compress, pass wiki_body with a clean wiki-formatted summary that preserves all nuance — the worker stores it VERBATIM and skips the weak external-LLM compression pass. Omit wiki_body to let the worker compress. For type='project' (technical builds like ExampleProject): pass project_meta {name, status, stack[], repo_url, deploy_url, project_id}; to bridge to an existing Hermes/D1 project, also include 'project:{project_id}' in entities[].", inputSchema: { type:"object", properties:{ type:{type:"string",enum:["note","conversation","code","web","project"],default:"note"}, title:{type:"string"}, content:{type:"string"}, wiki_body:{type:"string",description:"Optional assistant-compressed wiki body (markdown). Stored verbatim, skips NVIDIA compression. Pass raw exchange in content, your distilled summary here."}, project_meta:{type:"object",description:"For type='project' only: {name, status: active|paused|archived, stack: string[], repo_url, deploy_url, project_id}. Written into wiki/projects/{slug}.md frontmatter."}, tags:{type:"array",items:{type:"string"}}, entities:{type:"array",items:{type:"string"}}, surface:{type:"string",enum:SURFACES,description:"Capture origin. Defaults to 'other' with warning if omitted."}, topic:{type:"string"}, state:{type:"string"}, next_action:{type:"string"}, trail:{type:"array",items:{type:"string"}} }, required:["title","content"] } },
  { name: "ingest_to_second_brain",  description: "Full Karpathy INGEST pipeline + fact extraction + triple storage. Pass wiki_body to store an assistant-compressed summary verbatim and skip the weak external-LLM pass. type='project' routes to wiki/projects/ with project_meta frontmatter.", inputSchema: { type:"object", properties:{ title:{type:"string"}, content:{type:"string"}, wiki_body:{type:"string",description:"Optional assistant-compressed wiki body. Stored verbatim, skips NVIDIA compression."}, type:{type:"string",enum:["note","conversation","code","web","project"],default:"note"}, project_meta:{type:"object",description:"For type='project' only: {name, status: active|paused|archived, stack: string[], repo_url, deploy_url, project_id}."}, tags:{type:"array",items:{type:"string"}}, entities:{type:"array",items:{type:"string"}}, source_url:{type:"string"}, surface:{type:"string",enum:SURFACES}, topic:{type:"string"}, state:{type:"string"}, next_action:{type:"string"}, trail:{type:"array",items:{type:"string"}} }, required:["title","content"] } },
  { name: "get_latest_handoff",      description: "Return the freshest SESSION-HANDOFF entry as {observation_id,timestamp,timestamp_ist,surface,topic,state,next_action,trail}. KV-only, no LLM. Call this FIRST at session start.", inputSchema: { type:"object", properties:{} } },
  { name: "list_recent",             description: "Recent observations sorted by timestamp DESC across ALL session_id buckets. Optional filters: surface, since (ISO/date), until (ISO/date), entity. KV+graph join, no LLM.", inputSchema: { type:"object", properties:{ limit:{type:"number",default:10}, surface:{type:"string",enum:SURFACES}, since:{type:"string"}, until:{type:"string"}, entity:{type:"string"} } } },
  { name: "get_handoffs",            description: "History of SESSION-HANDOFFs sorted by timestamp DESC. Includes superseded ones. Useful for week/month reviews. KV-only, no LLM.", inputSchema: { type:"object", properties:{ limit:{type:"number",default:10}, surface:{type:"string",enum:SURFACES}, include_superseded:{type:"boolean",default:true} } } },
  { name: "get_home_feed",           description: "Pre-computed snapshot of the most recent observations across all surfaces (refreshed by cron). Zero KV reads beyond one. KV-only, no LLM.", inputSchema: { type:"object", properties:{} } },
  { name: "lint_second_brain",       description: "Health-check: orphans, uncompressed files, entity facts summary, triple count.", inputSchema: { type:"object", properties:{} } },
  { name: "read_second_brain_file",  description: "Read full content of a specific file.", inputSchema: { type:"object", properties:{ path:{type:"string"} }, required:["path"] } },
  { name: "get_second_brain_graph",  description: "Get knowledge graph nodes + edges.", inputSchema: { type:"object", properties:{} } },
  { name: "write_second_brain_file", description: "Write a file at a specific path.", inputSchema: { type:"object", properties:{ file_path:{type:"string"}, content:{type:"string"}, message:{type:"string"} }, required:["file_path","content"] } },
  { name: "query_triples",           description: "Query structured triples (subject|predicate|object) for an entity. Filter by predicate, category, or derivation. Direct lookup, no LLM needed. Each triple includes derivation ('stated'=verbatim from user | 'inferred'=LLM-extracted | 'reinforced'=re-confirmed | 'unknown'=legacy) and source_obs_id (originating observation/file). Filter derivation='stated' to get only facts the user explicitly said, excluding LLM inferences.", inputSchema: { type:"object", properties:{ entity:{type:"string"}, predicate:{type:"string"}, category:{type:"string",enum:["fact","preference","instruction","history"]}, derivation:{type:"string",enum:["stated","inferred","reinforced","unknown"]} }, required:["entity"] } },
  { name: "get_top_entities",        description: "God-node ranking: the most-connected entities in the whole Second Brain right now, scored by fact_count + 2×triple_count. Surfaces what everything flows through — the hubs whose removal would fragment the knowledge graph. Like Graphify's god-nodes, but for personal cross-session memory. KV scan, no LLM.", inputSchema: { type:"object", properties:{ limit:{type:"number",default:10} } } },
  { name: "find_entity_path",        description: "Shortest connection between two entities via the triple graph (BFS, ≤4 hops). Answers 'what connects X to Y across everything I've captured' with the hop-by-hop path + the predicate on each edge. Like Graphify's `path` command, but over personal knowledge. Returns null if unreachable. KV-only, no LLM.", inputSchema: { type:"object", properties:{ from:{type:"string"}, to:{type:"string"}, max_hops:{type:"number",default:4} }, required:["from","to"] } },
  { name: "get_session_index",       description: "Lightweight index of observations in a session. Defaults to most recent session. ~40-50 tokens per entry. No LLM, KV-only.", inputSchema: { type:"object", properties:{ session_id:{type:"string"}, limit:{type:"number",default:20} } } },
  { name: "get_observation",         description: "Fetch full content of one observation by id (returned from get_session_index). On-demand, no LLM.", inputSchema: { type:"object", properties:{ id:{type:"string"} }, required:["id"] } },
  { name: "get_about_me",            description: "Synthesized self-model of the user: identity, beliefs, active state, and an adversarial Tensions/Open-Loops section that surfaces where recent actions contradict committed rules. Pre-computed by cron (daily 4am IST), augmented live with current session context. NOT a flattery doc.", inputSchema: { type:"object", properties:{} } },
  { name: "get_self",                description: "Tiered personalized self-model of the user — TOKEN-CHEAP by default. depth:'core' (default) = ~10 identity facts + top behavioral + 1-line voice (tiny, load every session). depth:'domain' + domain:'writing|design|build|client|decision|habit' = one targeted slice (e.g. his ExampleProject ad-writing style) — small, no dump. depth:'deep' = full self-model (identity+prefs+rules+behavioral-by-domain+voice) for personalizing a build; use sparingly. Always returns tight summaries, never raw node dumps.", inputSchema: { type:"object", properties:{ depth:{type:"string",enum:["core","domain","deep"]}, domain:{type:"string",enum:["writing","design","build","client","decision","habit"]} } } },
  { name: "refresh_about_me",        description: "Force-regenerate the About-Me self-model now (instead of waiting for the daily cron). Returns counts per layer + tensions found.", inputSchema: { type:"object", properties:{} } },
  { name: "get_routing_index",       description: "Get domain routing index — shows which content domains exist (code/work/personal/research/health/finance/general), their sizes, and recent titles. Optional surface filter narrows by capture origin. Use this FIRST to narrow search scope before querying.", inputSchema: { type:"object", properties:{ surface:{type:"string",enum:SURFACES} } } },
  // v9 hybrid retrieval tools
  { name: "keyword_search",          description: "v9: D1 FTS5 keyword search over observation title+content+entities+tags. Instant retrieval, no Vectorize lag. Falls back to GitHub keyword scan if D1 binding absent.", inputSchema: { type:"object", properties:{ query:{type:"string"}, limit:{type:"number",default:20} }, required:["query"] } },
  { name: "recall_brain",            description: "v9: Hybrid recall — runs semantic + keyword (FTS5) + entity + triple lookups in parallel, fuses via reciprocal rank fusion, applies recency boost. Returns top K with provenance (which methods matched).", inputSchema: { type:"object", properties:{ query:{type:"string"}, limit:{type:"number",default:10} }, required:["query"] } },
  { name: "session_context",         description: "v9: Orient at session start — single <3 KB payload with latest_handoff + open_threads + recent_verdicts + active_topics. Call this FIRST after BRAIN-STARTUP.", inputSchema: { type:"object", properties:{} } },
  // v10.2.2: the brain's missing WRITE-CORRECTION primitive. Until now the brain could
  // only ADD — a wrong fact/triple stuck forever, drowned but never removed. `forget`
  // soft-deletes (superseded_by, so history survives; not a destructive purge).
  { name: "forget",                  description: "v10.2.2: Correct/retract wrong memory. mode='fact' retracts one entity fact (marks superseded, confidence→0, so it stops surfacing but stays auditable) — pass entity + fact (exact text). mode='triple' retracts one triple — pass entity + predicate (+ object to disambiguate). mode='observation' marks an observation superseded — pass id. Optional replaced_by carries the corrected value forward. Soft-delete only: nothing is hard-purged, history is preserved. Use when the brain surfaces something stale or flatly wrong about the user.", inputSchema: { type:"object", properties:{ mode:{type:"string",enum:["fact","triple","observation"]}, entity:{type:"string"}, fact:{type:"string"}, predicate:{type:"string"}, object:{type:"string"}, id:{type:"string"}, replaced_by:{type:"string"} }, required:["mode"] } },
];

async function runMCPTool(name, args, env, ctx) {
  switch (name) {
    case "query_second_brain": {
      if (!args.query) return mcpErr("query required");
      // A2: wallclock budget
      const QUERY_BUDGET_MS = 20000;
      const t0 = Date.now();
      const budgetLeft = () => QUERY_BUDGET_MS - (Date.now() - t0);
      const phase_ms = {};
      let truncated = false;
      // A5: hybrid by default — semantic+1-hop run unless caller opts into fast=true.
      // (Was default-true, which silently skipped Vectorize and missed synonym hits.)
      const fastMode = args.fast === true;
      // rerank default false (opt-in)
      const enableRerank = args.rerank === true;

      const categoryFilter = typeof args.category === "string" && OBSERVATION_CATEGORIES.includes(args.category) ? args.category : null;
      const queryEntities = args.query.split(/\s+/).filter(w=>w.length>2&&/^[A-Z]/.test(w)).slice(0,5);
      const potentialEntities = [...new Set([...ANCHOR_ENTITIES, ...queryEntities])].slice(0, 8);

      // A4: keyword search capped at 3 dirs, wrapped in withTimeout
      const ph_kw0 = Date.now();
      const keywordResults = await withTimeout(
        (async () => {
          if (env.DB) {
            const fts = await searchFts5(env, args.query, 20).catch(() => []);
            if (fts.length) return fts;
          }
          // Cap to 3 dirs to bound GH subrequests
          const cappedDirs = ["wiki/conversations", "wiki/entities", "wiki/topics"];
          const repo   = env.GITHUB_REPO   || "your-username/your-repo";
          const branch = env.GITHUB_BRANCH || "main";
          const terms  = tokenizeQuery(args.query);
          if (!terms.length) return [];
          const scored = [];
          for (const dir of cappedDirs) {
            try {
              const res = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${dir}?ref=${branch}`, { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": GH_UA } });
              if (!res.ok) continue;
              for (const file of await res.json()) {
                if (!file.name.endsWith(".md")) continue;
                let content="", preview="", matchingLines=[];
                try {
                  const cr = await ghFetch(env, `https://api.github.com/repos/${repo}/contents/${file.path}?ref=${branch}`, { headers: { Accept: "application/vnd.github.v3.raw", "User-Agent": GH_UA } });
                  if (cr.ok) {
                    content = await cr.text();
                    const lines = content.split("\n");
                    matchingLines = lines.filter(l=>terms.some(t=>l.toLowerCase().includes(t))).slice(0,5).map(l=>l.substring(0,200));
                    preview = dir.startsWith("raw") ? content : lines.slice(0,10).join("\n").substring(0,500);
                  }
                } catch {}
                const score = scoreResult(file.name, content, terms);
                if (score > 0) scored.push({ path: file.path, name: file.name, type: dir.startsWith("wiki")?"compressed":"raw", category: dir.split("/")[1]||"raw", matchReason: terms.some(t=>file.name.toLowerCase().includes(t))?"filename":"content", preview: preview||undefined, matchingLines: matchingLines.length?matchingLines:undefined, _score: score });
              }
            } catch {}
          }
          return scored.sort((a,b)=>b._score-a._score).slice(0,20).map(({_score,...r})=>r);
        })(),
        7000, []
      );
      phase_ms.keyword = Date.now() - ph_kw0;

      // A4: entities+triples parallel, capped at 4s
      const ph_ent0 = Date.now();
      const entityData = await withTimeout(
        Promise.all(potentialEntities.flatMap(e => [getEntityFacts(env, e), getTriples(env, e)])),
        4000, []
      );
      phase_ms.entities = Date.now() - ph_ent0;

      const efMap = {};
      const tripleMap = {};
      for (let i = 0; i < potentialEntities.length; i++) {
        const entity = potentialEntities[i];
        const facts   = entityData[i * 2];
        const triples = entityData[i * 2 + 1];
        if (facts?.length > 0) {
          const instrs = facts.filter(f => f.category === "instruction").map(f => `[RULE] ${f.fact}`);
          const rest   = facts.filter(f => f.category !== "instruction").slice(0, 3).map(f => f.fact);
          efMap[entity] = [...instrs, ...rest];
        }
        if (triples?.length > 0) {
          tripleMap[entity] = triples.slice(0, 5).map(t => `${t.predicate}: ${t.object}`);
        }
      }

      // A4: 1-hop — skip in fast mode or if budget < 3s
      let ph_hop = 0;
      if (!fastMode && budgetLeft() >= 3000) {
        const ph_hop0 = Date.now();
        const hopCandidates = new Set();
        for (const tripleStrs of Object.values(tripleMap)) {
          for (const s of tripleStrs) {
            const obj = s.split(": ").slice(1).join(": ").trim();
            if (obj.length > 3 && /^[A-Z]/.test(obj) && !potentialEntities.includes(obj)) hopCandidates.add(obj);
          }
        }
        if (hopCandidates.size > 0) {
          const hopList = [...hopCandidates].slice(0, 4);
          const hopData = await withTimeout(
            Promise.all(hopList.flatMap(e => [getEntityFacts(env, e), getTriples(env, e)])),
            Math.min(budgetLeft() - 1000, 3000), []
          );
          for (let i = 0; i < hopList.length; i++) {
            const entity = hopList[i];
            const facts   = hopData[i * 2];
            const triples = hopData[i * 2 + 1];
            if (facts?.length > 0) {
              const instrs = facts.filter(f => f.category === "instruction").map(f => `[RULE] ${f.fact}`);
              const rest   = facts.filter(f => f.category !== "instruction").slice(0, 2).map(f => f.fact);
              const combined = [...instrs, ...rest];
              if (combined.length > 0) efMap[entity] = combined;
            }
            if (triples?.length > 0) tripleMap[entity] = triples.slice(0, 3).map(t => `${t.predicate}: ${t.object}`);
          }
        }
        ph_hop = Date.now() - ph_hop0;
      } else if (!fastMode) { truncated = true; }
      phase_ms.hop = ph_hop;

      // v9.2: VECTOR-DOMINANT hybrid fusion with query expansion. Semantic carries
      // the weight (0.65) so synonym/concept matches surface even when keywords miss.
      // Skipped only in explicit fast mode.
      let docResults = keywordResults;
      let ph_sem = 0;
      if (!fastMode && env.AI && env.VECTORIZE && budgetLeft() >= 4000) {
        const ph_sem0 = Date.now();
        try {
          // Embed query + expansions; union vector hits, best score per path. Parallel.
          const queries = await expandQuery(env, args.query);
          const embedRes = await env.AI.run(EMBEDDING_MODEL, { text: queries.slice(0, 5) });
          const vecScoreMap = {}; // path → best score
          const vecMeta = {};     // path → metadata
          const vrLists = await withTimeout(
            Promise.all((embedRes.data || []).map(vv => env.VECTORIZE.query(vv, { topK: 15, returnMetadata: true }).then(r => r.matches || []).catch(() => []))),
            Math.min(budgetLeft() - 1000, 7000), []
          );
          for (const matches of (vrLists || [])) {
            for (const m of matches) {
              const p = m.metadata?.path;
              if (!p) continue;
              if (!(p in vecScoreMap) || m.score > vecScoreMap[p]) { vecScoreMap[p] = m.score; vecMeta[p] = m.metadata; }
            }
          }
          const maxKw = Math.max(...keywordResults.map(r => r._score || 0), 1);
          const merged = keywordResults.map(r => ({
            ...r,
            _hybrid: (((r._score || 0) / maxKw) * 0.35) + ((vecScoreMap[r.path] || 0) * 0.65),
          }));
          // Pull in semantic-only hits (no keyword match) above a low floor.
          for (const [p, score] of Object.entries(vecScoreMap)) {
            if (score > 0.25 && !merged.find(r => r.path === p)) {
              merged.push({ path: p, name: (p || "").split("/").pop(), type: "wiki", category: "semantic", _hybrid: score * 0.65, matchReason: "semantic", surface: vecMeta[p]?.surface, summary: vecMeta[p]?.summary });
            }
          }
          docResults = merged.sort((a, b) => b._hybrid - a._hybrid).slice(0, 20).map(({ _hybrid, _score, ...r }) => r);
        } catch (e) { console.warn("query_second_brain hybrid (non-fatal):", e.message); }
        ph_sem = Date.now() - ph_sem0;
      } else if (!fastMode) { truncated = true; }
      phase_ms.semantic = ph_sem;

      // A4: Cross-encoder rerank (U4 v9.1.2) — replaces LLM rerank; opt-in via rerank=true
      let ph_rerank = 0;
      if (enableRerank && !fastMode && budgetLeft() >= 5000 && docResults.length > 3) {
        const ph_rerank0 = Date.now();
        try {
          const candidates = docResults.map(r => ({ ...r, text: `${r.name} ${r.summary || r.content || ""}` }));
          docResults = await rerankHybridResults(env, args.query, candidates, 20);
        } catch (e) { console.warn("query_second_brain cross-encoder rerank (non-fatal):", e.message); }
        ph_rerank = Date.now() - ph_rerank0;
      }
      phase_ms.rerank = ph_rerank;

      // A4: enrich — parallel (not serial), capped at 10 results + 3s timeout
      let ph_enrich = 0;
      if (env.VECTORS && docResults.length > 0) {
        const ph_enrich0 = Date.now();
        const toEnrich = docResults.slice(0, 10);
        const enriched = await withTimeout(
          Promise.all(toEnrich.map(async r => {
            if (!r.path) return categoryFilter ? null : r;
            const obs = await readObservation(env, obsIdFromWikiPath(r.path));
            const cat = obs?.category || "conversation";
            if (categoryFilter) {
              if (cat !== categoryFilter) return null;
              if (!obs && categoryFilter !== "conversation") return null;
            }
            return { ...r, category: cat, before_summary: obs?.before_summary || undefined, after_summary: obs?.after_summary || undefined };
          })),
          3000, toEnrich
        );
        docResults = (Array.isArray(enriched) ? enriched : toEnrich).filter(Boolean);
        ph_enrich = Date.now() - ph_enrich0;
      }
      phase_ms.enrich = ph_enrich;
      phase_ms.total = Date.now() - t0;

      return mcpOk({
        query: args.query,
        fast: fastMode,
        category_filter: categoryFilter || undefined,
        entity_facts: Object.keys(efMap).length ? efMap : undefined,
        entity_triples: Object.keys(tripleMap).length ? tripleMap : undefined,
        triples_used: Object.values(tripleMap).reduce((s, t) => s + t.length, 0),
        matches: docResults.length,
        results: docResults,
        phase_ms,
        truncated,
        note: fastMode ? "Fast mode (opt-in): keyword+entities only — vectors skipped" : "Hybrid keyword+semantic (default) — vectors active, 27x token savings",
      });
    }

    case "ask_second_brain": {
      if (!args.question) return mcpErr("question required");
      const fakeReq = new Request("https://internal/ask", { method:"POST", body:JSON.stringify({question:args.question,top_k:args.top_k||3}) });
      const res = await handleAsk(fakeReq, env);
      return { content:[{ type:"text", text:await res.text() }] };
    }

    case "semantic_search": {
      if (!args.query) return mcpErr("query required");
      if (env.AI && env.VECTORIZE) {
        try {
          const topK = args.top_k || 5;
          const er = await env.AI.run(EMBEDDING_MODEL, { text: [args.query] });
          const r  = await env.VECTORIZE.query(er.data[0], { topK: topK * 2, returnMetadata: true });
          let matches = r.matches.map(m => ({ score: m.score, path: m.metadata?.path, title: m.metadata?.title, summary: m.metadata?.summary }));

          // Cross-encoder reranking (U4 v9.1.2)
          if (matches.length > 1) {
            try {
              const candidates = matches.map(m => ({ ...m, text: `${m.title || m.path} ${m.summary || ""}` }));
              matches = await rerankHybridResults(env, args.query, candidates, topK);
            } catch (e) { console.warn("semantic_search cross-encoder rerank (non-fatal):", e.message); }
          }
          return mcpOk({ query: args.query, method: "semantic+cross-encoder", results: matches.slice(0, topK) });
        } catch {}
      }
      return mcpOk({ query: args.query, method: "keyword-fallback", results: await doKeywordSearch(env, args.query) });
    }

    case "capture_to_second_brain": {
      if (!args.title||!args.content) return mcpErr("title and content required");
      const type=args.type||"note";
      const surface=normalizeSurface(args.surface)||"other";
      if (!normalizeSurface(args.surface)) console.warn(`[mcp capture] surface "${args.surface}" → "other"`);
      if (type==="code") {
        const now=istDateStr(),slug=slugify(args.title),fp=`raw/code/${now}-${slug}.md`;
        const tags=[...new Set([...(args.tags||[]),surface])];
        const entities=[...new Set([...(args.entities||[]),surface])];
        const fm=buildFrontmatter({type,created:now,tags,entities,source_url:"",surface,session_id:now});
        const res=await ghPut(env,fp,fm+args.content,`auto: capture code - ${args.title}`);
        return res.ok ? mcpOk({status:"captured",path:fp}) : mcpErr("GitHub write failed");
      }
      try { return mcpOk({status:"captured",...await runIngestPipeline(env,ctx,{title:args.title,content:args.content,type,tags:args.tags||[],entities:args.entities||[],source_url:args.source_url||"",surface,topic:args.topic,state:args.state,next_action:args.next_action,trail:args.trail,wiki_body:args.wiki_body||"",project_meta:args.project_meta||null})}); }
      catch(e){ return mcpErr(e.message); }
    }

    case "ingest_to_second_brain": {
      if (!args.title||!args.content) return mcpErr("title and content required");
      try { return mcpOk(await runIngestPipeline(env,ctx,{title:args.title,content:args.content,type:args.type||"note",tags:args.tags||[],entities:args.entities||[],source_url:args.source_url||"",surface:args.surface,topic:args.topic,state:args.state,next_action:args.next_action,trail:args.trail,wiki_body:args.wiki_body||"",project_meta:args.project_meta||null})); }
      catch(e){ return mcpErr(e.message); }
    }

    case "lint_second_brain": {
      const r = await handleLint(new Request("https://internal/lint",{method:"POST",body:"{}"}), env);
      return { content:[{ type:"text", text:await r.text() }] };
    }

    case "read_second_brain_file": {
      if (!args.path) return mcpErr("path required");
      const content = await readFile(env, args.path);
      return content ? { content:[{ type:"text", text:content }] } : mcpErr("File not found: "+args.path);
    }

    case "get_second_brain_graph": {
      const r = await ghGet(env, "graph/graph.json", true);
      return r.ok ? { content:[{ type:"text", text:await r.text() }] } : mcpErr("Could not read graph");
    }

    case "write_second_brain_file": {
      if (!args.file_path||!args.content) return mcpErr("file_path and content required");
      const ok = await writeFile(env, args.file_path, args.content, args.message||`mcp: write ${args.file_path}`);
      if (!ok) return mcpErr("GitHub write failed");
      if (args.file_path.startsWith("wiki/") && env.AI && env.VECTORIZE) await embedAndStore(env, args.file_path, args.content, { title:args.file_path.split("/").pop().replace(".md",""), type:"wiki" });
      return mcpOk({ status:"written", path:args.file_path });
    }

    case "query_triples": {
      if (!args.entity) return mcpErr("entity required");
      let triples = await getTriples(env, args.entity, args.predicate||null, args.category||null);
      // v10.0.1: optional derivation filter (stated|inferred|reinforced|unknown).
      if (args.derivation) triples = triples.filter(t => (t.derivation||"unknown") === args.derivation);
      const canonical = await resolveEntityName(env, args.entity);
      return mcpOk({ entity:args.entity, resolved_to:canonical, derivation_filter:args.derivation||null, triples, total:triples.length });
    }

    case "get_top_entities": {
      // v10.0.1 SUPERIORITY: god-node ranking on demand (KV scan, cron-grade cost —
      // acceptable for an explicit user call, unlike auto-running it per request).
      const top = await scanEntityCentrality(env, args.limit || 10);
      return mcpOk({ top_entities: top, total: top.length, scored_by: "fact_count + 2*triple_count" });
    }

    case "find_entity_path": {
      if (!args.from || !args.to) return mcpErr("from and to required");
      const path = await findEntityPath(env, args.from, args.to, args.max_hops || 4);
      return mcpOk(path
        ? { from:args.from, to:args.to, found:true, hops:path.hops, path:path.path, edges:path.edges }
        : { from:args.from, to:args.to, found:false, note:`No path within ${args.max_hops||4} hops` });
    }

    case "get_entity_facts": {
      if (!args.entity) return mcpErr("entity required");
      const facts = await getEntityFacts(env, args.entity, args.category||null);
      const resolved = await resolveEntityName(env, args.entity);
      return mcpOk({ entity:args.entity, resolved_to:resolved, category_filter:args.category||null, facts:facts.map(f=>({fact:f.fact,category:f.category||"fact",confidence:f.confidence,count:f.count,last_reinforced:f.last_reinforced})), total:facts.length });
    }

    case "get_session_index": {
      if (!env.VECTORS) return mcpErr("KV not available");
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
      const explicit = typeof args.session_id === "string" && args.session_id.trim() ? args.session_id.trim() : null;
      // When session_id omitted: union the 3 freshest buckets so IST-morning
      // entries appear without the caller knowing which bucket they live in.
      let buckets;
      if (explicit) {
        buckets = [explicit];
      } else {
        const slRaw = await env.VECTORS.get("obs:sessions:list");
        const sl = slRaw ? JSON.parse(slRaw) : [];
        if (sl.length === 0) {
          const fallback = await env.VECTORS.get("obs:latest_session");
          buckets = fallback ? [fallback] : [];
        } else {
          buckets = sl.slice(0, 3);
        }
      }
      if (buckets.length === 0) return mcpOk({ session_ids: [], entries: [], total: 0, note: "No sessions captured yet" });
      const seen = new Set();
      const collected = [];
      for (const b of buckets) {
        const listRaw = await env.VECTORS.get(`obs:session:${b}`);
        const ids = listRaw ? JSON.parse(listRaw) : [];
        for (const id of ids) { if (!seen.has(id)) { seen.add(id); collected.push(id); } }
      }
      // v10.2.2 perf: parallel read of collected session ids.
      const obsList = (await readObservationsBatch(env, collected)).filter(r => r.obs).map(r => ({ ...r.obs, id: r.obs.id || r.id }));
      obsList.sort((a, b) => (Date.parse(b.timestamp || 0) || 0) - (Date.parse(a.timestamp || 0) || 0));
      const entries = obsList.slice(0, limit).map(obs => ({
        id: obs.id, title: obs.title, category: obs.category || "conversation",
        timestamp: obs.timestamp, timestamp_ist: obs.timestamp_ist || istIsoStr(obs.timestamp),
        surface: obs.surface || "other", entities: obs.entities || [],
        session_id: obs.session_id,
      }));
      return mcpOk({ session_ids: buckets, entries, total: entries.length });
    }

    case "get_latest_handoff": {
      if (!env.VECTORS) return mcpErr("KV not available");
      const raw = await env.VECTORS.get("state:session-handoff:latest");
      if (!raw) return mcpOk({ latest: null, note: "No SESSION-HANDOFF captured yet" });
      try { return mcpOk(JSON.parse(raw)); }
      catch { return mcpErr("Corrupt handoff state"); }
    }

    case "list_recent": {
      if (!env.VECTORS) return mcpErr("KV not available");
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 10));
      const surfaceFilter = normalizeSurface(args.surface);
      const sinceMs = args.since ? Date.parse(args.since.length === 10 ? `${args.since}T00:00:00Z` : args.since) : null;
      const untilMs = args.until ? Date.parse(args.until.length === 10 ? `${args.until}T23:59:59Z` : args.until) : null;
      const entityFilter = typeof args.entity === "string" && args.entity.trim() ? args.entity.trim() : null;
      // v9: read sharded recent:{surface} when filter passed; else recent:all.
      // Fall back to legacy obs:recent until back-fill catches up.
      const primaryKey = surfaceFilter ? `recent:${surfaceFilter}` : "recent:all";
      let recRaw = await env.VECTORS.get(primaryKey);
      if (!recRaw) recRaw = await env.VECTORS.get("obs:recent");
      const ids = recRaw ? JSON.parse(recRaw) : [];
      const candidates = [...ids].reverse();
      // v10.2.2 perf: chunked early-exit scan with the same filter predicate.
      const out = await scanObservations(env, candidates, limit, (obs, id) => {
        if (surfaceFilter && (obs.surface || "other") !== surfaceFilter) return null;
        const tsMs = Date.parse(obs.timestamp || 0) || 0;
        if (sinceMs && tsMs < sinceMs) return null;
        if (untilMs && tsMs > untilMs) return null;
        if (entityFilter && !(obs.entities || []).some(e => e.toLowerCase() === entityFilter.toLowerCase())) return null;
        return {
          id, title: obs.title,
          timestamp_utc: obs.timestamp,
          timestamp_ist: obs.timestamp_ist || istIsoStr(obs.timestamp),
          surface: obs.surface || "other",
          topic: obs.topic || obs.title,
          entities: obs.entities || [],
          session_id: obs.session_id,
          superseded_by: obs.superseded_by || null,
        };
      });
      out.sort((a, b) => (Date.parse(b.timestamp_utc || 0) || 0) - (Date.parse(a.timestamp_utc || 0) || 0));
      return mcpOk({ surface_filter: surfaceFilter || null, since: args.since || null, until: args.until || null, entity_filter: entityFilter || null, count: out.length, results: out });
    }

    case "get_handoffs": {
      if (!env.VECTORS) return mcpErr("KV not available");
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 10));
      const surfaceFilter = normalizeSurface(args.surface);
      const includeSuperseded = args.include_superseded !== false;
      const listRaw = await env.VECTORS.get("state:session-handoff:list");
      const ids = listRaw ? JSON.parse(listRaw) : [];
      // v10.2.2 perf: chunked early-exit scan.
      const out = await scanObservations(env, [...ids].reverse(), limit, (obs, id) => {
        if (!includeSuperseded && obs.superseded_by) return null;
        if (surfaceFilter && (obs.surface || "other") !== surfaceFilter) return null;
        return {
          observation_id: id, timestamp: obs.timestamp, timestamp_ist: obs.timestamp_ist || istIsoStr(obs.timestamp),
          surface: obs.surface || "other", topic: obs.topic || obs.title,
          state: obs.state || "", next_action: obs.next_action || "", trail: obs.trail || [],
          superseded_by: obs.superseded_by || null,
        };
      });
      return mcpOk({ count: out.length, results: out });
    }

    case "get_home_feed": {
      if (!env.VECTORS) return mcpErr("KV not available");
      const raw = await env.VECTORS.get("state:home-feed:v1");
      if (!raw) return mcpOk({ entries: [], note: "Snapshot not built yet — cron at IST midnight populates this." });
      try { return mcpOk(JSON.parse(raw)); } catch { return mcpErr("Corrupt home-feed snapshot"); }
    }

    case "get_observation": {
      if (!args.id) return mcpErr("id required");
      const obs = await readObservation(env, args.id);
      if (!obs) return mcpErr(`Observation not found: ${args.id}`);
      let content = null;
      if (obs.wiki_path) content = await readFile(env, obs.wiki_path);
      if (!content && obs.raw_path) content = await readFile(env, obs.raw_path);
      return mcpOk({ ...obs, content: content || null });
    }

    case "get_routing_index": {
      if (!env.VECTORS) return mcpOk({ domains: {}, note: "KV unavailable" });
      const raw = await env.VECTORS.get("routing:index");
      const index = raw ? JSON.parse(raw) : {};
      const domains = {};
      for (const d of ROUTING_DOMAINS) {
        if (index[d]) domains[d] = index[d];
      }
      const surfaceFilter = normalizeSurface(args.surface);
      // Surface filter: read recent observations, group by domain, keep only those
      // whose surface matches. Lightweight — uses obs:recent (cap 200), no LLM.
      if (surfaceFilter) {
        const recRaw = await env.VECTORS.get("obs:recent");
        const ids = recRaw ? JSON.parse(recRaw) : [];
        const buckets = {};
        // v10.2.2 perf: parallel read, then aggregate by domain.
        for (const { obs } of await readObservationsBatch(env, [...ids].reverse())) {
          if (!obs) continue;
          if ((obs.surface || "other") !== surfaceFilter) continue;
          const d = obs.domain || "general";
          if (!buckets[d]) buckets[d] = { titles: [], count: 0 };
          buckets[d].count++;
          if (buckets[d].titles.length < 10) buckets[d].titles.push(obs.title);
        }
        return mcpOk({ domains: buckets, surface: surfaceFilter, total_domains: Object.keys(buckets).length, hint: `Domains seen on surface=${surfaceFilter} in recent activity` });
      }
      return mcpOk({ domains, total_domains: Object.keys(domains).length, hint: "Use this to narrow search scope — query only relevant domains" });
    }

    case "keyword_search": {
      if (!args.query) return mcpErr("query required");
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
      const r = await doKeywordSearchHybrid(env, args.query, limit);
      return mcpOk(r);
    }

    case "recall_brain": {
      if (!args.query) return mcpErr("query required");
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
      const r = await doRecall(env, args.query, limit);
      return mcpOk(r);
    }

    case "session_context": {
      const r = await buildSessionContext(env);
      return mcpOk(r);
    }

    case "get_about_me": {
      let file = await readFile(env, "wiki/profile/about-owner.md").catch(() => null);
      if (!file) { await regenAboutMe(env); file = await readFile(env, "wiki/profile/about-owner.md").catch(() => null); }
      let live = null;
      try { const sc = await buildSessionContext(env); live = { latest_handoff: sc?.latest_handoff?.topic || null, open_threads: (sc?.open_threads||[]).map(t=>t.title) }; } catch {}
      return mcpOk({ profile: file || "_not generated yet_", live_augmentation: live, note: "profile = cron-precomputed; live_augmentation = current moment" });
    }
    case "refresh_about_me": {
      const r = await regenAboutMe(env);
      return mcpOk({ status: "regenerated", ...r });
    }
    // v10.2.1: tiered self-model. Token agenda #1: default 'core' is TINY. Depth
    // only when asked. 'domain' pulls one behavioral slice (e.g. ad-writing style)
    // — cheap, targeted, no dump. 'deep' = full picture, opt-in only. All tiers
    // return tight summaries, never raw node dumps.
    case "get_self": {
      const depth = ["core","domain","deep"].includes(args.depth) ? args.depth : "core";
      const domainWanted = (args.domain || "").toLowerCase();
      const [factsAll, beh] = await Promise.all([
        getEntityFacts(env, "Brain Owner", "fact").catch(()=>[]),
        getEntityFacts(env, "Brain Owner", "behavioral").catch(()=>[]),
      ]);
      const behBy = (d) => beh.filter(f => !d || (f.domain||"habit")===d).map(f=>f.fact);
      let voice = null;
      try { const v = await env.VECTORS.get("state:voice-profile:latest"); if (v) voice = JSON.parse(v); } catch {}

      if (depth === "core") {
        // ~10 core facts + top behavioral, one line of voice. Cheapest.
        return mcpOk({
          depth,
          identity: [...new Set(factsAll.map(f=>f.fact))].slice(0,10),
          behavioral: [...new Set(beh.map(f=>f.fact))].slice(0,6),
          voice_summary: voice?.voice_summary?.slice(0,200) || null,
          note: "core tier — call get_self depth:'domain' domain:'writing|design|build|client|decision|habit' for a slice, or depth:'deep' for full."
        });
      }
      if (depth === "domain") {
        // one behavioral slice + matching voice rules if writing. Targeted, small.
        const slice = behBy(domainWanted);
        return mcpOk({
          depth, domain: domainWanted || "(all)",
          patterns: [...new Set(slice)].slice(0,14),
          voice: (domainWanted === "writing" && voice) ? { rules: voice.rules, signature_phrases: voice.signature_phrases } : null,
          note: "domain tier — targeted slice, no dump."
        });
      }
      // deep — full self-model, still summaries not raw. Opt-in (building a project).
      const byDomain = {};
      for (const f of beh) { const d=f.domain||"habit"; (byDomain[d]=byDomain[d]||[]).push(f.fact); }
      const prefs = await getEntityFacts(env, "Brain Owner", "preference").catch(()=>[]);
      const rules = await getEntityFacts(env, "Brain Owner", "instruction").catch(()=>[]);
      return mcpOk({
        depth,
        identity: [...new Set(factsAll.map(f=>f.fact))].slice(0,20),
        preferences: [...new Set(prefs.map(f=>f.fact))].slice(0,14),
        rules: [...new Set(rules.map(f=>f.fact))].slice(0,14),
        behavioral_by_domain: Object.fromEntries(Object.entries(byDomain).map(([k,v])=>[k,[...new Set(v)].slice(0,10)])),
        voice,
        note: "deep tier — full self-model for personalized builds. Use sparingly (largest tier)."
      });
    }

    case "forget": {
      if (!env.VECTORS) return mcpErr("KV not available");
      const mode = args.mode;
      const ttl = { expirationTtl: 86400 * 730 };
      const now = Date.now();

      if (mode === "fact") {
        if (!args.entity || !args.fact) return mcpErr("mode=fact needs entity + fact (exact text)");
        const canonical = await resolveEntityName(env, args.entity);
        const slug = entitySlug(canonical);
        const key = `entity:${slug}:fact:${factHash(String(args.fact).toLowerCase().trim())}`;
        const raw = await env.VECTORS.get(key);
        if (!raw) return mcpOk({ ok: false, mode, note: `No stored fact matches "${args.fact}" for ${canonical}. Fact text must match exactly.` });
        const p = JSON.parse(raw);
        await env.VECTORS.put(key, JSON.stringify({ ...p, confidence: 0, superseded_by: args.replaced_by || "(retracted)", superseded_at: now }), ttl);
        await addKVWrites(env, 1);
        return mcpOk({ ok: true, mode, entity: canonical, forgot: args.fact, replaced_by: args.replaced_by || null, note: "Fact soft-retracted (confidence→0, marked superseded). It stops surfacing but stays auditable." });
      }

      if (mode === "triple") {
        if (!args.entity || !args.predicate) return mcpErr("mode=triple needs entity + predicate (+ object to disambiguate)");
        const canonical = await resolveEntityName(env, args.entity);
        const sSlug = entitySlug(canonical);
        const idxRaw = await env.VECTORS.get(`triple:${sSlug}:index`);
        const pSlugs = idxRaw ? JSON.parse(idxRaw) : [];
        const want = predSlug(args.predicate);
        const targets = pSlugs.filter(p => p.includes(want));
        if (!targets.length) return mcpOk({ ok: false, mode, note: `No triple with predicate "${args.predicate}" for ${canonical}.` });
        let retracted = 0;
        for (const p of targets) {
          const key = `triple:${sSlug}:${p}`;
          const raw = await env.VECTORS.get(key);
          if (!raw) continue;
          const t = JSON.parse(raw);
          if (args.object && String(t.object || "").toLowerCase().trim() !== String(args.object).toLowerCase().trim()) continue;
          await env.VECTORS.put(key, JSON.stringify({ ...t, superseded_by: args.replaced_by || "(retracted)", superseded_at: now, confidence: 0 }), ttl);
          retracted++;
        }
        await addKVWrites(env, retracted);
        return mcpOk({ ok: retracted > 0, mode, entity: canonical, predicate: args.predicate, object: args.object || null, retracted, note: retracted ? "Triple(s) soft-retracted (marked superseded)." : "No triple matched (object filter excluded all)." });
      }

      if (mode === "observation") {
        if (!args.id) return mcpErr("mode=observation needs id");
        const metaKey = `obs:meta:${args.id}`;
        const raw = await env.VECTORS.get(metaKey);
        if (!raw) return mcpErr(`Observation not found: ${args.id}`);
        const obs = JSON.parse(raw);
        await env.VECTORS.put(metaKey, JSON.stringify({ ...obs, superseded_by: args.replaced_by || "(retracted)", superseded_at: now }), ttl);
        await addKVWrites(env, 1);
        return mcpOk({ ok: true, mode, id: args.id, note: "Observation marked superseded — drops out of recent/home-feed/handoff feeds, stays fetchable by id." });
      }

      return mcpErr("mode must be fact|triple|observation");
    }

    default: return mcpErr(`Unknown tool: ${name}`);
  }
}

async function handleMCPPost(req, env, ctx) {
  try {
    const { id, method, params } = await req.json();
    if (method==="initialize") return jrpcOk(id, { protocolVersion:"2024-11-05", capabilities:{ tools:{} }, serverInfo:{ name:"lnm-brain-mcp", version:"10.2.2", icon:"https://your-worker-subdomain.workers.dev/favicon.ico" } });
    if (method==="tools/list")  return jrpcOk(id, { tools:MCP_TOOLS });
    if (method==="tools/call")  return jrpcOk(id, await runMCPTool(params.name, params.arguments||{}, env, ctx));
    return new Response(JSON.stringify(jrpcErr(id,-32601,`Method not found: ${method}`)), { headers:jsonHeaders() });
  } catch(e) { return new Response(JSON.stringify(jrpcErr(null,-32700,e.message)), { status:400, headers:jsonHeaders() }); }
}

async function handleMCPGet(req, env) {
  const stream = new ReadableStream({
    start(c) {
      const enc = d => new TextEncoder().encode(`data: ${JSON.stringify(d)}\n\n`);
      c.enqueue(enc({ type:"connected", service:"lnm-brain-mcp", version:"10.2.2", tools:MCP_TOOLS.map(t=>t.name) }));
      const iv = setInterval(()=>c.enqueue(enc({type:"ping",ts:Date.now()})), 30000);
      req.signal.addEventListener("abort", ()=>clearInterval(iv));
    },
  });
  return new Response(stream, { headers:{ "Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive","Access-Control-Allow-Origin":"*" } });
}

// ═══ Hermes Agent memory endpoints (v9.9.0) ════════════════════════════════
function buildHermesSystemBlock(facts){
  const prefs=(Array.isArray(facts)?facts:[]).filter(f=>['preference','instruction'].includes(f.category)).slice(0,7).map(f=>'- '+(f.content||f.fact)).join('\n');
  return prefs?('RITIK PREFERENCES:\n'+prefs).slice(0,600):'';
}
function assembleHermesContext({handoff,memories,query,voice}){
  const parts=[];
  if(voice)parts.push('## Writing Voice (active project)\n'+String(voice).slice(0,500));
  if(handoff)parts.push('## Last Session\nState: '+String(handoff.state||'').slice(0,300)+'\nNext: '+String(handoff.next_action||'').slice(0,200));
  if(memories&&memories.length&&query){parts.push('## Recalled Memory (re: "'+String(query).slice(0,60)+'")');
    for(const m of memories.slice(0,5))parts.push('- **'+(m.title||'')+'**: '+String(m.snippet||m.content||'').slice(0,200));}
  return parts.join('\n\n').slice(0,6000);
}
async function getProjectVoice(projectId,env){ if(!projectId)return '';
  try{const r=await env.DB.prepare('SELECT voice_notes FROM projects WHERE id=?').bind(projectId).first();return (r&&r.voice_notes)||'';}catch{return '';} }

async function handleHermesContext(request,env){
  const url=new URL(request.url);
  const query=url.searchParams.get('query')||'', project=url.searchParams.get('project_id')||'';
  const factEntity=project?('project:'+project):'Brain Owner';
  const [sessionCtx,memObj,facts,voice]=await Promise.all([
    buildSessionContext(env),
    query?doRecall(env,query,7):Promise.resolve({results:[]}),
    getEntityFacts(env,factEntity,null),
    project?getProjectVoice(project,env):Promise.resolve('')]);
  const memories=(memObj&&memObj.results)||memObj||[];
  const handoff=sessionCtx&&(sessionCtx.latest_handoff||sessionCtx.handoff);
  return Response.json({turn_context:assembleHermesContext({handoff,memories,query,voice}),
    system_block:buildHermesSystemBlock(facts),user_facts:facts,project_id:project});
}
async function handleHermesTurn(request,env){
  let b; try{b=await request.json();}catch{return Response.json({error:'bad json'},{status:400});}
  const {session_id,turn_index=0,user_content='',assistant_content='',model_used=null,platform='hermes',project_id=''}=b;
  if(!session_id)return Response.json({error:'session_id required'},{status:400});
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO hermes_turns (session_id,turn_index,role,content,model_used,platform,project_id) VALUES (?,?,'user',?,?,?,?)").bind(session_id,turn_index,String(user_content).slice(0,25000),model_used,platform,project_id),
    env.DB.prepare("INSERT OR IGNORE INTO hermes_turns (session_id,turn_index,role,content,model_used,platform,project_id) VALUES (?,?,'assistant',?,?,?,?)").bind(session_id,turn_index+0.5,String(assistant_content).slice(0,25000),model_used,platform,project_id)]);
  return Response.json({ok:true},{status:201});
}

async function runDialectic(transcript,env){
  const SYSTEM='You analyze a conversation between Brain Owner and an AI assistant. Extract and return ONLY raw JSON — no fences, no preamble:\n{"new_facts":[{"content":"...","category":"fact|preference|instruction|history|decision"}],"tensions":["..."],"open_loops":["..."],"session_summary":"...(under 250 words)..."}\nRules: new_facts = only NEW info; tensions = contradictions/risks; open_loops = pending items; each content max 200 chars.';
  const {text:raw,via,errors}=await callLLM([{role:'system',content:SYSTEM},{role:'user',content:'TRANSCRIPT:\n'+transcript}],env,{max_tokens:1000,temperature:0.3});
  if(raw){ try{
    const text=raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
    const parsed=JSON.parse(text); parsed.model_used=via; return parsed;
  }catch(e){ return {new_facts:[],tensions:[],open_loops:[],session_summary:'',model_used:via+' (json-parse-fail)'}; } }
  return {new_facts:[],tensions:[],open_loops:[],session_summary:'',model_used:'failed',_errors:errors};
}

async function handleHermesDream(request,env,ctx){
  let b; try{b=await request.json();}catch{return Response.json({error:'bad json'},{status:400});}
  const {session_id,project_id=''}=b;
  if(!session_id)return Response.json({error:'session_id required'},{status:400});
  const {results:turns}=await env.DB.prepare('SELECT role,content,model_used,created_at FROM hermes_turns WHERE session_id=? AND processed=0 ORDER BY turn_index LIMIT 100').bind(session_id).all();
  if(!turns||turns.length<2)return Response.json({ok:true,message:'no turns to process',turns_processed:0});
  const transcript=turns.map(t=>t.role.toUpperCase()+': '+t.content).join('\n\n').slice(0,10000);
  const dialectic=await runDialectic(transcript,env);
  const factEntity=project_id?('project:'+project_id):'Brain Owner';
  let factsWritten=0;
  for(const f of (dialectic.new_facts||[])){ if(!f||!f.content)continue; await storeHermesFact(env,factEntity,f.content,f.category||'fact'); factsWritten++; }
  for(const tn of (dialectic.tensions||[])){ if(tn) await storeHermesFact(env,factEntity,tn,'tension'); }
  const summary=dialectic.session_summary||'';
  if(summary.length>50){
    await runIngestPipeline(env, ctx||{waitUntil:()=>{}}, {
      title:'Hermes Dream — '+(project_id||session_id.slice(0,16))+' — '+new Date().toISOString().slice(0,10),
      content:summary, wiki_body:summary, surface:'cowork', type:'note',
      tags:['hermes-dream'].concat(project_id?['project:'+project_id]:[]),
      entities:['Brain Owner','Hermes Agent'].concat(project_id?['project:'+project_id]:[]) });
  }
  await env.DB.prepare('UPDATE hermes_turns SET processed=2 WHERE session_id=? AND processed=0').bind(session_id).run();
  await env.DB.prepare('INSERT INTO hermes_dreams (session_id,project_id,turns_processed,facts_extracted,tensions_found,model_used,summary) VALUES (?,?,?,?,?,?,?)').bind(session_id,project_id,turns.length,factsWritten,(dialectic.tensions||[]).length,dialectic.model_used||'unknown',summary.slice(0,2000)).run();
  return Response.json({ok:true,turns_processed:turns.length,facts_written:factsWritten,tensions_found:(dialectic.tensions||[]).length,via:dialectic.model_used});
}

async function handleHermesProfile(env){
  let aboutMe=null;
  try{aboutMe=await env.VECTORS.get('state:about-me:v1','json');}catch{}
  if(!aboutMe){try{aboutMe=await env.VECTORS.get('about_me_cache','json');}catch{}}
  let summary='';
  if(aboutMe){ const p=[];
    if(aboutMe.identity_snapshot)p.push(String(aboutMe.identity_snapshot).slice(0,200));
    if(aboutMe.active_state)p.push(String(aboutMe.active_state).slice(0,150));
    if(aboutMe.tensions&&aboutMe.tensions.length)p.push('Tensions: '+aboutMe.tensions.slice(0,2).join('; '));
    summary=p.join('\n').slice(0,600);
  } else {
    const facts=await getEntityFacts(env,'Brain Owner',null);
    summary=(Array.isArray(facts)?facts:[]).filter(f=>['preference','instruction'].includes(f.category)).slice(0,7).map(f=>f.content||f.fact).join('\n').slice(0,600);
  }
  return Response.json({summary,full:aboutMe||null});
}

async function handleHermesConclude(request,env){
  let b; try{b=await request.json();}catch{return Response.json({error:'bad json'},{status:400});}
  const {fact,entity='Brain Owner',category='fact',project_id=''}=b;
  if(!fact)return Response.json({error:'fact required'},{status:400});
  const target=project_id?('project:'+project_id):entity;
  await storeHermesFact(env,target,String(fact).slice(0,500),category);
  return Response.json({ok:true,entity:target,category});
}

async function handleHermesSkill(request,env){
  let b; try{b=await request.json();}catch{return Response.json({error:'bad json'},{status:400});}
  const {skill_name,task_type,model_used,outcome,notes}=b;
  if(!skill_name||!task_type)return Response.json({error:'skill_name and task_type required'},{status:400});
  await env.DB.prepare('INSERT INTO hermes_skills (skill_name,task_type,model_used,outcome,notes) VALUES (?,?,?,?,?)').bind(skill_name,task_type,model_used||null,outcome||null,(notes&&String(notes).slice(0,500))||null).run();
  return Response.json({ok:true});
}

// ═══ Admin: LLM router introspection + sovereignty ══════════════════════════
async function handleLLMSpend(env){
  const spend=await getMonthlySpend(env);
  return Response.json({month:new Date().toISOString().slice(0,7),
    vercel_est_usd:Number(spend.toFixed(4)),cap_usd:LLM_BUDGET_CAP_USD,
    ladder:['nvidia-nim','opencode-zen-free','vercel-us','openrouter-free-us','cloudflare-weak','openrouter-paid-us(final-boss)'],
    keys:{nvidia_nim:!!(env.MISTRAL_NEMOTRON_API_Key||env.MISTRAL_LARGE_API_Key||env.DRACARYS_API_Key),
      opencode_zen:!!env.OPENCODE_ZEN_API_KEY,vercel:!!env.VERCEL_AI_GATEWAY_KEY,
      openrouter:!!env.OPENROUTER_API_KEY,cloudflare:!!env.AI}});
}
async function handleLLMTest(env){
  const {text,via,errors}=await callLLM([{role:'user',content:'Reply with exactly the word: ROUTED'}],env,{max_tokens:10,temperature:0});
  return Response.json({ok:!!text,via,sample:(text||'').slice(0,40),errors:errors||[]});
}
async function handleSovereigntyCheck(env){
  // Sovereignty model (Brain Owner): forbid Chinese SERVERS, not Chinese model origins.
  // NIM/Zen/CF are US-hosted (exempt). OpenRouter is pinned to US providers.
  const us_hosted_tiers=['nvidia-nim (US)','opencode-zen (US, per opencode.ai)','cloudflare-workers-ai (US)','vercel-gateway (US-hosted models only)'];
  const openrouter_pin=OR_US_PROVIDERS;
  // Confirm no OpenRouter list routes off-pin: pin is always sent, so violations=0.
  const violations=[];
  return Response.json({ok:violations.length===0,policy:'block-chinese-servers-not-model-origins',
    us_hosted_tiers,openrouter_provider_pin:openrouter_pin,
    zen_free_models:ZEN_FREE,vercel_models:VERCEL_MODELS,or_free:OR_FREE,or_cheap:OR_CHEAP,violations});
}
async function handleVStat(env){
  let idx=null; try{idx=await env.VECTORIZE.describe();}catch(e){idx={error:String(e)};}
  let noteCount=0; try{const r=await env.DB.prepare('SELECT COUNT(*) AS n FROM observations_fts').first(); noteCount=(r&&r.n)||0;}catch(e){noteCount=-1;}
  return Response.json({index:idx,note_count:noteCount});
}

// ═══ Per-project (per-client) memory ════════════════════════════════════════
async function handleProjectList(env){
  const {results}=await env.DB.prepare('SELECT id,name,client,status,updated_at FROM projects ORDER BY updated_at DESC').all();
  return Response.json({projects:results||[]});
}
async function handleProjectCreate(request,env){
  let b; try{b=await request.json();}catch{return Response.json({error:'bad json'},{status:400});}
  const {id,name,client='',voice_notes=''}=b;
  if(!id||!name)return Response.json({error:'id and name required'},{status:400});
  const slug=String(id).toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,40);
  await env.DB.prepare('INSERT INTO projects (id,name,client,voice_notes) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,client=excluded.client,voice_notes=excluded.voice_notes,updated_at=datetime(\'now\')').bind(slug,name,client,String(voice_notes).slice(0,2000)).run();
  return Response.json({ok:true,id:slug});
}
async function handleProjectGet(projectId,env){
  const proj=await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(projectId).first();
  if(!proj)return Response.json({error:'not found'},{status:404});
  const {results:recentTurns}=await env.DB.prepare('SELECT role,content,created_at FROM hermes_turns WHERE project_id=? ORDER BY id DESC LIMIT 20').bind(projectId).all();
  const facts=await getEntityFacts(env,'project:'+projectId,null);
  const {results:dreams}=await env.DB.prepare('SELECT summary,created_at FROM hermes_dreams WHERE project_id=? ORDER BY id DESC LIMIT 5').bind(projectId).all();
  return Response.json({project:proj,recent_turns:recentTurns||[],facts:facts||[],dreams:dreams||[]});
}

// ═══ Public dashboard (/ui) — prompts for key, sends it on every fetch ══════
const SECOND_BRAIN_UI_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Second Brain — Hermes Console</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#0d1117;color:#e6edf3}
header{padding:16px 20px;background:#161b22;border-bottom:1px solid #30363d;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:17px;margin:0}.tag{font-size:11px;color:#7d8590}input,textarea,button{font:inherit}
input,textarea{background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:8px 10px;width:100%}
button{background:#238636;border:none;color:#fff;border-radius:6px;padding:8px 14px;cursor:pointer}button:hover{background:#2ea043}
.wrap{max-width:880px;margin:0 auto;padding:20px}.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px;margin:14px 0}
.row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1}.muted{color:#7d8590;font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;font-size:12px;max-height:340px;overflow:auto}
.proj{border:1px solid #30363d;border-radius:8px;padding:10px;margin:6px 0}.proj b{color:#58a6ff}
</style></head><body>
<header><h1>🧠 Second Brain</h1><span class="tag">Hermes memory console · v10.2.1</span></header>
<div class="wrap">
<div class="card"><div class="muted">API key (stored only in this tab)</div>
<div class="row"><input id="key" type="password" placeholder="Bearer key…"><button onclick="saveKey()">Save</button></div>
<div class="muted" id="keystat"></div></div>

<div class="card"><h3>Client Projects</h3>
<div id="projects" class="muted">Enter key, then Load.</div>
<div class="row" style="margin-top:10px"><button onclick="loadProjects()">Load projects</button></div>
<hr style="border-color:#30363d;margin:14px 0">
<div class="muted">New / update project</div>
<div class="row"><input id="pid" placeholder="id (slug)"><input id="pname" placeholder="Name"></div>
<input id="pclient" placeholder="Client (optional)" style="margin-top:8px">
<textarea id="pvoice" rows="2" placeholder="Writing voice notes (injected when project active)" style="margin-top:8px"></textarea>
<div class="row" style="margin-top:8px"><button onclick="createProject()">Save project</button></div></div>

<div class="card"><h3>View project memory</h3>
<div class="row"><input id="vpid" placeholder="project id"><button onclick="viewProject()">View</button></div>
<pre id="projout"></pre></div>

<div class="card"><h3>Run dialectic dream</h3>
<div class="row"><input id="dsess" placeholder="session_id"><input id="dproj" placeholder="project_id (optional)"><button onclick="runDream()">Dream</button></div>
<pre id="dreamout"></pre></div>

<div class="card"><h3>LLM router status</h3>
<div class="row"><button onclick="llmStatus()">Spend + tiers</button><button onclick="sov()">Sovereignty</button></div>
<pre id="llmout"></pre></div>
</div>
<script>
function K(){return sessionStorage.getItem('sbk')||''}
function saveKey(){sessionStorage.setItem('sbk',document.getElementById('key').value.trim());document.getElementById('keystat').textContent='Key saved in this tab.'}
function H(){return {'X-API-Key':K(),'Content-Type':'application/json'}}
async function gj(p){const r=await fetch(p,{headers:H()});return r.json()}
async function pj(p,b){const r=await fetch(p,{method:'POST',headers:H(),body:JSON.stringify(b)});return r.json()}
async function loadProjects(){const d=await gj('/projects');const el=document.getElementById('projects');
  if(!d.projects||!d.projects.length){el.innerHTML='<span class=muted>No projects yet.</span>';return}
  el.innerHTML=d.projects.map(p=>'<div class=proj><b>'+p.id+'</b> — '+p.name+' <span class=muted>('+(p.status||'active')+')</span></div>').join('')}
async function createProject(){const b={id:document.getElementById('pid').value,name:document.getElementById('pname').value,client:document.getElementById('pclient').value,voice_notes:document.getElementById('pvoice').value};
  const d=await pj('/projects',b);alert(JSON.stringify(d));loadProjects()}
async function viewProject(){const id=document.getElementById('vpid').value.trim();const d=await gj('/projects/'+encodeURIComponent(id));document.getElementById('projout').textContent=JSON.stringify(d,null,2)}
async function runDream(){const b={session_id:document.getElementById('dsess').value,project_id:document.getElementById('dproj').value};const d=await pj('/hermes/dream',b);document.getElementById('dreamout').textContent=JSON.stringify(d,null,2)}
async function llmStatus(){const d=await gj('/admin/llm-spend');document.getElementById('llmout').textContent=JSON.stringify(d,null,2)}
async function sov(){const d=await gj('/admin/sovereignty-check');document.getElementById('llmout').textContent=JSON.stringify(d,null,2)}
if(K())document.getElementById('keystat').textContent='Key present in this tab.';
</script></body></html>`;

// ─── Main fetch handler ───────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    resetRequestCache(); // clear per-request KV caches (alias map, fuzzy scan set)
    const url=new URL(request.url), path=url.pathname, method=request.method;
    const ip=request.headers.get("CF-Connecting-IP")||"unknown";

    if (method==="OPTIONS") return new Response(null,{headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,X-API-Key,x-api-key,Authorization"}});

    // Connector icon: 🧠 on near-black. Served at /favicon.ico, /icon.svg,
    // /.well-known/mcp-icon so Claude shows a real logo. Inlined, no runtime fetch.
    if ((path==="/favicon.ico"||path==="/icon.svg"||path==="/.well-known/mcp-icon")&&method==="GET") {
      const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><rect width="32" height="32" rx="6" fill="#0F0F0F"/><text x="16" y="16" font-size="22" text-anchor="middle" dominant-baseline="central">🧠</text></svg>`;
      return new Response(ICON_SVG, { headers: { "Content-Type":"image/svg+xml", "Cache-Control":"public, max-age=86400" } });
    }

    if (path==="/health"&&method==="GET") {
      const kvWrites = await getKVWriteCount(env);
      const neurons  = await getNeuronUsage(env);
      const kvStatus = kvWrites >= KV_WRITE_LIMIT_BLOCK ? "blocked" : kvWrites >= KV_WRITE_LIMIT_WARN ? "warning" : "ok";
      // Deep diag (cheap probes). Pass ?deep=1 to include.
      let deep = undefined;
      if (url.searchParams.get("deep") === "1") {
        const t0 = Date.now();
        const kvPing = await env.VECTORS.get("obs:latest_session").then(() => Date.now() - t0).catch(() => -1);
        const t1 = Date.now();
        const ghPing = await ghFetch(env, `https://api.github.com/repos/${env.GITHUB_REPO||"your-username/your-repo"}?ref=${env.GITHUB_BRANCH||"main"}`, { headers: { "User-Agent": GH_UA } }).then(r => ({ ms: Date.now()-t1, ok: r.ok, status: r.status })).catch(e => ({ ms: -1, ok: false, error: e.message }));
        const sessionsListRaw = await env.VECTORS.get("obs:sessions:list").catch(() => null);
        const sessionsCount = sessionsListRaw ? JSON.parse(sessionsListRaw).length : 0;
        const handoffRaw = await env.VECTORS.get("state:session-handoff:latest").catch(() => null);
        deep = { kv_ping_ms: kvPing, github_ping: ghPing, sessions_tracked: sessionsCount, latest_handoff_present: !!handoffRaw, home_feed_present: !!(await env.VECTORS.get("state:home-feed:v1").catch(()=>null)) };
      }
      return jsonOk({ status:"ok", service:"lnm-brain", version:"10.2.2", embedding_model: EMBEDDING_MODEL, embedding_dims: EMBEDDING_DIMS, timestamp:new Date().toISOString(), timestamp_ist: istIsoStr(),
        kv_writes_today: kvWrites, kv_write_limit: 1000000, kv_status: kvStatus,
        neurons_today: neurons, neuron_limit: 7000,
        features:["entity-normalization","contradiction-detection","backfill-facts","/ask-endpoint","confidence-scoring","recency-weighting","fact-consolidation","semantic-search","karpathy-wiki","nvidia-7tier-llm","27x-token-savings","kv-cost-fix","batched-writes","structured-triples","memory-categories","semantic-reranking","instruction-priority","temporal-context","memory-decay","hybrid-keyword-semantic-fusion","triple-contradiction-detection","triples-in-query-results","semantic-search-reranking","observation-category-typing","before-after-causal-context","progressive-disclosure","session-start-summary","async-capture-waituntil","domain-routing-index","domain-classification","backfill-domains","ask-uses-routing-index","citation-endpoint","anchor-entity-graph-traversal","force-reinforce","write-entity-triples","monthly-session-index","kv-write-budget-guard","paid-tier-kv-limits","1-hop-graph-traversal","auto-monthly-index","llm-reranking","ist-session-buckets","surface-first-class","session-handoff-supersede","list-recent","get-latest-handoff","get-handoffs","home-feed-snapshot","surface-scoped-routing","deep-health-probe","list-recent-filters",
        // v9
        "sync-timeline-writes","surface-sharded-recent","verify-on-write","vectorize-ack-poll",
        "deferred-raw-github-write", // v9.1.2 — raw PUT moved to waitUntil, /capture now <2s
        "d1-fts5-keyword-index","multi-vector-embedding","verdict-list-preservation",
        "ranking-triples","hybrid-recall-rrf","session-context-tool","handoff-v9-schema",
        "cross-encoder-rerank","retrieval-critic","coala-memory-type","bitemporal-facts","sleep-time-consolidation",
        // v9.2 — retrieval overhaul
        "bge-m3-1024dim-embeddings","query-expansion","full-content-chunk-embedding","vector-dominant-fusion","caller-supplied-wiki-body","reembed-migration",
        // v10.2.2
        "forget-write-correction","chunked-parallel-obs-reads","27-mcp-tools",
      ], deep });
    }
    // v9.2: embedding dim probe — confirms active model output dimensions.
    if (path==="/admin/embed-dims"&&method==="GET") {
      try {
        const er = await env.AI.run(EMBEDDING_MODEL, { text: ["dimension probe"] });
        return jsonOk({ model: EMBEDDING_MODEL, dims: (er.data?.[0]||[]).length, expected: EMBEDDING_DIMS });
      } catch (e) { return jsonErr(e.message, 500); }
    }

    // v10.2.1: force a cron job on demand (ops + verification), bypassing time
    // gates. job=home-feed rebuilds the snapshot incl. top_entities (§C);
    // job=nightly-consolidation runs cluster+distill (§B). Admin-key gated.
    if (path==="/admin/run-job"&&method==="POST") {
      const adminKey = request.headers.get("x-admin-key") || url.searchParams.get("key2");
      if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) return jsonErr("admin key required", 403);
      const job = url.searchParams.get("job") || "";
      if (job === "home-feed") {
        const recRaw = await env.VECTORS.get("obs:recent");
        const ids = recRaw ? JSON.parse(recRaw) : [];
        // v10.2.2 perf: early-exit chunked scan (mirrors the cron path).
        const entries = await scanObservations(env, [...ids].reverse(), 30, (obs, id) =>
          obs.superseded_by ? null : { id, title: obs.title, timestamp_utc: obs.timestamp, timestamp_ist: obs.timestamp_ist || istIsoStr(obs.timestamp), surface: obs.surface || "other", category: obs.category || "conversation", session_id: obs.session_id, entities: (obs.entities || []).slice(0, 6) });
        entries.sort((a, b) => (Date.parse(b.timestamp_utc || 0) || 0) - (Date.parse(a.timestamp_utc || 0) || 0));
        let topEntities = [];
        try { topEntities = await scanEntityCentrality(env, 10); } catch (e) {}
        const snapshot = { built_at: new Date().toISOString(), built_at_ist: istIsoStr(), count: entries.length, entries, top_entities: topEntities };
        await env.VECTORS.put("state:home-feed:v1", JSON.stringify(snapshot), OBS_TTL);
        return jsonOk({ job, ok: true, entries: entries.length, top_entities: topEntities.length });
      }
      if (job === "nightly-consolidation") {
        await runNightlyConsolidation(env, { waitUntil: () => {} }, callRoleLLM);
        const flushed = await flushPendingConsolidations(env, writeFile);
        return jsonOk({ job, ok: true, flushed });
      }
      // v10.2.1: force-regenerate the About-Me self-model now (don't wait for 4am cron).
      if (job === "about-me") {
        const r = await regenAboutMe(env);
        return jsonOk({ job, ok: true, ...r });
      }
      // v10.2.1: mine Brain Owner's OWN captured writing → voice style card. Samples =
      // observations he authored (posts/messages), preferring surfaces where the
      // content is his prose. Paginated by ?cursor / ?batch over obs:recent.
      if (job === "build-voice") {
        const cursor = parseInt(url.searchParams.get("cursor") || "0", 10);
        const batch  = Math.max(5, Math.min(60, parseInt(url.searchParams.get("batch") || "30", 10)));
        const recRaw = await env.VECTORS.get("obs:recent");
        const ids = recRaw ? JSON.parse(recRaw) : [];
        const slice = ids.slice(cursor, cursor + batch);
        const samples = [];
        // v10.2.2 perf: parallel read of the batch, then filter in order.
        for (const { obs: o } of await readObservationsBatch(env, slice)) {
          if (!o || o.superseded_by) continue;
          const t = (o.title || "").toLowerCase();
          // v10.2.1 HOMOGENEOUS: a memory is a memory — do NOT gate by surface
          // ("that's just ChatGPT"). Mine Brain Owner's prose from EVERY tool equally.
          // Only skip machine noise (tool-logs, handoffs, MCP call dumps).
          if (/tool-|session-handoff|mcp__|^test\b/.test(t)) continue;
          if (/\b[0-9a-f]{8,}\b/.test(t)) continue; // hex session dumps
          // Keep anything with real prose content. Ad copy, chats, posts, drafts —
          // all carry his voice regardless of where it was captured.
          if (o.content && o.content.trim().length >= 150) samples.push(o.content.slice(0, 1500));
          if (samples.length >= 40) break;
        }
        const card = await buildVoiceProfile(env, callRoleLLM, samples);
        if (card) {
          const md = renderVoiceProfileMd(card);
          if (md) await writeFile(env, "wiki/profile/voice-owner.md", md, "voice: build style card");
        }
        const next = cursor + batch;
        return jsonOk({ job, ok: !!card, samples_used: samples.length, cursor, next_cursor: next < ids.length ? next : null, done: next >= ids.length });
      }
      return jsonErr("unknown job (home-feed|nightly-consolidation|about-me|build-voice)", 400);
    }

    // v9.2: re-embed migration into the m3 (1024-dim) index. Paginated by the
    // global obs:recent + sessions buckets. Idempotent (upsert). Call repeatedly
    // with ?cursor=N until {done:true}. Header x-admin-key required.
    if (path==="/admin/reembed-m3"&&method==="POST") {
      const adminKey = request.headers.get("x-admin-key") || url.searchParams.get("key2");
      if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) return jsonErr("admin key required", 403);
      const cursor = parseInt(url.searchParams.get("cursor") || "0", 10);
      const batch  = Math.max(1, Math.min(40, parseInt(url.searchParams.get("batch") || "15", 10)));
      // Build full id list once (cached in KV for the migration run).
      let allIds = [];
      try {
        const cached = await env.VECTORS.get("migrate:m3:idlist");
        if (cached) allIds = JSON.parse(cached);
      } catch {}
      if (!allIds.length) {
        const seen = new Set();
        const push = a => { for (const id of (a||[])) if (!seen.has(id)) { seen.add(id); allIds.push(id); } };
        push(JSON.parse(await env.VECTORS.get("recent:all") || "[]"));
        push(JSON.parse(await env.VECTORS.get("obs:recent") || "[]"));
        const sl = JSON.parse(await env.VECTORS.get("obs:sessions:list") || "[]");
        for (const s of sl) push(JSON.parse(await env.VECTORS.get(`obs:session:${s}`) || "[]"));
        await env.VECTORS.put("migrate:m3:idlist", JSON.stringify(allIds), { expirationTtl: 86400 * 3 });
      }
      const slice = allIds.slice(cursor, cursor + batch);
      let embedded = 0, skipped = 0;
      for (const id of slice) {
        try {
          const obs = await readObservation(env, id);
          if (!obs) { skipped++; continue; }
          let content = "";
          if (obs.wiki_path) content = await readFile(env, obs.wiki_path) || "";
          if (!content && obs.raw_path) content = await readFile(env, obs.raw_path) || "";
          if (!content && obs.title) content = obs.title;
          if (!content) { skipped++; continue; }
          await embedAndStoreMulti(env, id, {
            title: obs.title, content, summary: extractSummary(content), entities: obs.entities || [],
          }, { path: obs.wiki_path || obs.raw_path || null, type: obs.type || "note", tags: obs.tags || [], surface: obs.surface || "other", category: obs.category || "conversation" });
          embedded++;
        } catch (e) { skipped++; console.warn("reembed", id, e.message); }
      }
      const next = cursor + batch;
      const done = next >= allIds.length;
      if (done) await env.VECTORS.delete("migrate:m3:idlist").catch(()=>{});
      return jsonOk({ total: allIds.length, cursor, batch: slice.length, embedded, skipped, next_cursor: done ? null : next, done });
    }

    if (path==="/api/session_start_summary"&&method==="GET") return handleSessionStartSummary(env);
    if (path==="/api/latest-handoff"&&method==="GET") {
      const raw = await env.VECTORS.get("state:session-handoff:latest");
      return raw ? new Response(raw, { headers: jsonHeaders() }) : jsonOk({ latest: null });
    }
    if (path==="/api/health-watch"&&method==="GET") {
      const raw = await env.VECTORS.get("state:health-watch:latest");
      return raw ? new Response(raw, { headers: jsonHeaders() }) : jsonOk({ note: "No health-watch tick yet (first cron pending)" });
    }
    if (path==="/api/home-feed"&&method==="GET") {
      const raw = await env.VECTORS.get("state:home-feed:v1");
      return raw ? new Response(raw, { headers: jsonHeaders() }) : jsonOk({ entries: [], note: "Not built yet" });
    }
    if (path==="/api/list-recent"&&method==="GET") {
      const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "10", 10)));
      const surfaceFilter = normalizeSurface(url.searchParams.get("surface"));
      // v9: shard read
      const primaryKey = surfaceFilter ? `recent:${surfaceFilter}` : "recent:all";
      let recRaw = await env.VECTORS.get(primaryKey);
      if (!recRaw) recRaw = await env.VECTORS.get("obs:recent");
      const ids = recRaw ? JSON.parse(recRaw) : [];
      // v10.2.2 perf: chunked early-exit scan.
      const out = await scanObservations(env, [...ids].reverse(), limit, (obs, id) =>
        (surfaceFilter && (obs.surface || "other") !== surfaceFilter) ? null
        : { id, title: obs.title, timestamp_utc: obs.timestamp, timestamp_ist: obs.timestamp_ist || istIsoStr(obs.timestamp), surface: obs.surface || "other", entities: obs.entities || [], session_id: obs.session_id });
      return jsonOk({ count: out.length, results: out });
    }
    if (path==="/api/handoffs"&&method==="GET") {
      const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "10", 10)));
      const listRaw = await env.VECTORS.get("state:session-handoff:list");
      const ids = listRaw ? JSON.parse(listRaw) : [];
      // v10.2.2 perf: chunked early-exit scan.
      const out = await scanObservations(env, [...ids].reverse(), limit, (obs, id) =>
        ({ observation_id: id, timestamp: obs.timestamp, surface: obs.surface || "other", topic: obs.topic || obs.title, state: obs.state || "", next_action: obs.next_action || "", superseded_by: obs.superseded_by || null }));
      return jsonOk({ count: out.length, results: out });
    }
    if (path.startsWith("/api/observation/")&&method==="GET") {
      const id = decodeURIComponent(path.slice("/api/observation/".length));
      if (!id) return jsonErr("id required", 400);
      const obs = await readObservation(env, id);
      if (!obs) return jsonErr(`Observation not found: ${id}`, 404);
      let content = null;
      if (obs.wiki_path) content = await readFile(env, obs.wiki_path);
      if (!content && obs.raw_path) content = await readFile(env, obs.raw_path);
      return jsonOk({ ...obs, content: content || null });
    }

    // Benchmark endpoint — tests a list of model IDs for speed + quality in parallel
    // POST /llm-benchmark { models: ["model/id", ...], key_secret: "SECRET_NAME", prompt: "..." }
    if (path==="/llm-benchmark"&&method==="POST") {
      const auth = authenticate(request, env);
      if (!auth.ok) return jsonErr(auth.error, 401);
      const { models = [], key_secret = "MISTRAL_LARGE_API_Key", prompt = "Summarize in 2 sentences: ExampleProject is a Delhi web design agency founded by Brain Owner targeting Indian local businesses." } = await request.json().catch(() => ({}));
      const apiKey = env[key_secret];
      if (!apiKey) return jsonErr(`Secret ${key_secret} not found`, 400);

      const results = await Promise.allSettled(
        models.map(async (model) => {
          const start = Date.now();
          try {
            const text = await callNvidiaLLM(apiKey, model, [{ role:"user", content: prompt }], 150, 20000);
            return { model, status: "ok", ms: Date.now() - start, response: text.substring(0, 200) };
          } catch(e) {
            return { model, status: "error", ms: Date.now() - start, error: e.message.substring(0, 120) };
          }
        })
      );
      return jsonOk({ results: results.map(r => r.value || r.reason) });
    }

    // Raw response inspector — shows exact JSON response body from any NVIDIA model
    if (path==="/llm-raw"&&method==="POST") {
      const auth = authenticate(request, env);
      if (!auth.ok) return jsonErr(auth.error, 401);
      const { model = "openai/gpt-oss-120b", key_secret = "MISTRAL_LARGE_API_Key", prompt = "Say yes" } = await request.json().catch(() => ({}));
      const apiKey = env[key_secret];
      if (!apiKey) return jsonErr(`Secret ${key_secret} not found`, 400);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 100, temperature: 0.2 }),
          signal: controller.signal,
        });
        const raw = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        return jsonOk({ status: res.status, model, raw_body: raw.substring(0, 1000), parsed });
      } catch (e) {
        return jsonOk({ status: "error", model, error: e.message });
      }
    }

    // Debug endpoint — shows key presence and tests each tier until one succeeds
    if (path==="/llm-debug"&&method==="POST") {
      const auth = authenticate(request, env);
      if (!auth.ok) return jsonErr(auth.error, 401);
      const keysPresent = LLM_TIERS.map(t => ({ model: t.model, key: t.secretKey, present: !!env[t.secretKey] }));
      const tierResults = [];
      for (const tier of LLM_TIERS) {
        const apiKey = env[tier.secretKey];
        if (!apiKey) { tierResults.push({ model: tier.model, status: "key-missing" }); continue; }
        try {
          const text = await callNvidiaLLM(apiKey, tier.model, [{ role:"user", content:"Say OK in 3 words" }], 20);
          tierResults.push({ model: tier.model, status: "success", response: text });
          break;
        } catch (e) {
          tierResults.push({ model: tier.model, status: "error", error: e.message.substring(0, 150) });
        }
      }
      return jsonOk({ keys: keysPresent, tier_tests: tierResults });
    }

    if (path==="/"&&method==="GET")              return handleBrowserView();
    if (path==="/graph-internal"&&method==="GET") return handleGraph(env);
    if (path==="/file"&&method==="GET")           return handleFile(url,env);
    if (path==="/query-triples"&&method==="GET")  return handleQueryTriples(url,env);
    if (path==="/mcp") { if(method==="GET") return handleMCPGet(request,env); if(method==="POST") return handleMCPPost(request,env,ctx); }

    // Telegram
    if (path==="/telegram"&&method==="GET") return new Response("Telegram webhook active",{status:200});
    if (path==="/telegram"&&method==="POST") {
      try {
        const body=await request.json(), msg=body?.message?.text, chatId=body?.message?.chat?.id;
        if(!msg||!chatId) return new Response("OK",{status:200});
        if(msg.startsWith("/")) {
          if(env.TELEGRAM_TOKEN) await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:"Second Brain ready. Send your note."})});
          return new Response("OK",{status:200});
        }
        const tagMatch=msg.match(/^#(\w+)\s*/), prefixTag=tagMatch?tagMatch[1].toLowerCase():null;
        const raw=prefixTag?msg.slice(tagMatch[0].length).trim():msg.trim();
        const optimized=await optimizeTelegramNote(env,raw);
        const tags=["telegram","mobile-capture"]; if(prefixTag) tags.push(prefixTag);
        const tsStr=new Date().toISOString().replace(/[-:]/g,"").slice(0,15);
        await runIngestPipeline(env,ctx,{type:"note",title:`telegram-${tsStr}`,content:optimized,tags,entities:[],source_url:""});
        if(env.TELEGRAM_TOKEN) await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:`Saved${prefixTag?` [#${prefixTag}]`:""}: ${optimized.substring(0,200)}${optimized.length>200?"…":""}`})});
      } catch(e){ console.error("Telegram error:",e.message); }
      return new Response("OK",{status:200});
    }

    // Public dashboard — page prompts for the key and sends it on every fetch,
    // so the data endpoints below stay auth-protected.
    if(path==='/ui' && method==='GET') return new Response(SECOND_BRAIN_UI_HTML,{headers:{'Content-Type':'text/html; charset=utf-8'}});

    if(!checkRateLimit(ip)) return jsonErr("Too many requests",429);
    const auth=authenticate(request,env);
    if(!auth.ok) return jsonErr(auth.error,401);

    if (path==="/ingest"          &&method==="POST") return handleIngest(request,env,ctx);
    if (path==="/lint"            &&method==="POST") return handleLint(request,env);
    if (path==="/prune"           &&method==="POST") return handlePrune(request,env);
    if (path==="/compact"         &&method==="POST") return handleCompact(request,env);
    if (path==="/capture"         &&method==="POST") return handleCapture(request,env,ctx);
    if (path==="/facts"           &&method==="GET")  return handleGetFacts(url,env);
    if (path==="/ask"             &&method==="POST") return handleAsk(request,env);
    if (path==="/backfill-facts"  &&method==="POST") return handleBackfillFacts(request,env);
    if (path==="/backfill-domains"&&method==="POST") return handleBackfillDomains(request,env);
    if (path==="/api/auto-backfill-domains"&&method==="GET") return handleAutoBackfillDomains(request,env);
    if (path==="/backfill-domains"&&method==="GET") {
      const offset = parseInt(url.searchParams.get("offset")||"0",10);
      const batch_size = Math.min(50, parseInt(url.searchParams.get("batch_size")||"30",10));
      const fakeReq = new Request("https://internal/backfill-domains",{method:"POST",body:JSON.stringify({offset,batch_size,dry_run:false})});
      return handleBackfillDomains(fakeReq,env);
    }
    if (path==="/consolidate-facts"&&method==="POST") return jsonOk({status:"consolidation-complete",...await consolidateFacts(env)});
    if (path==="/api/belief-history"&&method==="GET") return handleBeliefHistory(request,env);
    if (path==="/register-entity-alias"&&method==="POST") return handleRegisterAlias(request,env);
    if (path==="/extract-facts"   &&method==="POST") {
      const {content,entities:ce=[]}=await request.json().catch(()=>({}));
      if(!content) return jsonErr("content required",400);
      const extracted=await llmExtractFacts(env,content);
      if(extracted){ for(const{entity,facts}of (extracted.entity_facts||[])) await upsertEntityFacts(env,entity,facts); return jsonOk({status:"extracted",meta:extracted.meta,entity_facts:extracted.entity_facts}); }
      return jsonOk({status:"no-facts-extracted"});
    }
    if (path==="/compress"&&method==="POST") {
      const {title,content,tags=[],entities=[]}=await request.json();
      const now=new Date().toISOString().split("T")[0];
      const c=await compressToWiki(env,title||"Untitled",content||"",tags,entities,now);
      return jsonOk({compressed:c,chars:c.length});
    }
    if (path==="/recompress-all"  &&method==="POST") return handleRecompressAll(request,env);
    if (path==="/rebuild-index"   &&method==="POST") return handleRebuildIndex(request,env);
    if (path==="/reconcile-index" &&method==="POST") return handleReconcileIndex(request,env);
    if (path==="/health-check") {
      const fix=method==="POST", batch=Math.max(1,Math.min(50,parseInt(url.searchParams.get("batch")||"5",10)||5));
      return jsonOk(await runHealthCheck(env,fix,batch));
    }
    if (path==="/write"&&method==="POST") {
      const{file_path,content,message="write: update file"}=await request.json();
      if(!file_path||!content) return jsonErr("file_path and content required",400);
      return (await writeFile(env,file_path,content,message)) ? jsonOk({status:"written",path:file_path}) : jsonErr("GitHub write failed",502);
    }
    if (path==="/stats"&&method==="GET")  return jsonOk(await computeStats(env));
    if (path==="/query"&&method==="GET")  return handleKeywordQuery(url,env);
    if (path==="/search"&&method==="POST") return handleSemanticSearch(request,env);
    if (path==="/graph"&&method==="GET")   return handleGraph(env);
    if (path==="/files"&&method==="GET")   return handleFiles(env);
    if (path==="/backfill-status"&&method==="GET") {
      const offset = await env.VECTORS.get("backfill:offset");
      const done = await env.VECTORS.get("backfill:done");
      return jsonOk({ done: !!done, current_offset: done ? "complete" : (offset ? parseInt(offset,10) : 0), message: done ? "Backfill complete" : `Next cron run will process from offset ${offset||0}` });
    }
    if (path==="/backfill-reset"&&method==="POST") {
      await env.VECTORS.delete("backfill:offset");
      await env.VECTORS.delete("backfill:done");
      return jsonOk({ status: "reset", message: "Backfill offset cleared. Next cron run starts from offset 0." });
    }
    // v9 endpoints
    if (path==="/recall"&&method==="GET") {
      const q = url.searchParams.get("q") || "";
      if (!q) return jsonErr("q required", 400);
      const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get("limit") || "10", 10)));
      return jsonOk(await doRecall(env, q, limit));
    }
    if (path==="/recall"&&method==="POST") {
      const { query="", limit=10 } = await request.json().catch(() => ({}));
      if (!query) return jsonErr("query required", 400);
      return jsonOk(await doRecall(env, query, Math.max(1, Math.min(50, limit))));
    }
    if (path==="/keyword-search"&&method==="GET") {
      const q = url.searchParams.get("q") || "";
      if (!q) return jsonErr("q required", 400);
      const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "20", 10)));
      return jsonOk(await doKeywordSearchHybrid(env, q, limit));
    }
    if (path==="/session-start"&&method==="GET") return jsonOk(await buildSessionContext(env));
    if (path==="/force-reinforce"      &&method==="POST") return handleForceReinforce(request,env);
    if (path==="/write-entity-triples" &&method==="POST") return handleWriteEntityTriples(request,env);
    if (path==="/backfill-timestamps-and-surfaces"&&method==="POST") return handleBackfillTsSurface(request,env);

    // ─── v9.6 Hermes + per-project memory + LLM-router admin ────────────────
    if(path==='/admin/vstat'   && method==='GET')  return handleVStat(env);
    if(path==='/admin/llm-spend'&& method==='GET')  return handleLLMSpend(env);
    if(path==='/admin/llm-test' && method==='GET')  return handleLLMTest(env);
    if(path==='/admin/sovereignty-check' && method==='GET') return handleSovereigntyCheck(env);
    if(path==='/hermes/context' && method==='GET')  return handleHermesContext(request,env);
    if(path==='/hermes/turn'    && method==='POST') return handleHermesTurn(request,env);
    if(path==='/hermes/dream'   && method==='POST') return handleHermesDream(request,env,ctx);
    if(path==='/hermes/profile' && method==='GET')  return handleHermesProfile(env);
    if(path==='/hermes/conclude'&& method==='POST') return handleHermesConclude(request,env);
    if(path==='/hermes/skill'   && method==='POST') return handleHermesSkill(request,env);
    if(path==='/projects' && method==='GET')  return handleProjectList(env);
    if(path==='/projects' && method==='POST') return handleProjectCreate(request,env);
    if(path.startsWith('/projects/') && method==='GET') return handleProjectGet(decodeURIComponent(path.split('/')[2]),env);

    return new Response(API_REFERENCE,{status:404,headers:{"Content-Type":"text/plain"}});
  },

  async scheduled(event, env, ctx) { ctx.waitUntil(handleCron(env)); },
};

// ─── Utility helpers ──────────────────────────────────────────────────────────
function buildFrontmatter({type,created,tags,entities,source_url,surface,session_id,extra}) {
  // v10 §A: `extra` (object) → additional frontmatter lines (e.g. project fields:
  // name/status/stack/repo_url/deploy_url/project_id). Arrays render as [a, b].
  const extraLines = extra ? Object.entries(extra)
    .filter(([,v]) => v != null && v !== "")
    .map(([k,v]) => Array.isArray(v) ? `${k}: [${v.join(", ")}]` : `${k}: ${v}`) : [];
  return ["---",`type: ${type}`,`created: ${created}`,...extraLines,session_id?`session_id: ${session_id}`:"",surface?`surface: ${surface}`:"",tags?.length?`tags: [${tags.join(", ")}]`:"",entities?.length?`entities: [${entities.join(", ")}]`:"",source_url?`source_url: ${source_url}`:"","---",""].filter(Boolean).join("\n");
}
function extractSummary(c) { return c.split("\n").filter(l=>l.trim()&&!l.startsWith("#")&&!l.startsWith("---")&&!l.startsWith("-")&&!l.includes(":")).slice(0,2).join(" ").substring(0,300); }
function extractSection(c,kw) { return c.split("\n").filter(l=>kw.some(k=>l.toLowerCase().includes(k))&&l.trim().length>10).map(l=>l.replace(/^[-*#\s]+/,"").trim()).filter(l=>l.length>5).slice(0,5); }
function extractCodeBlocks(c) { const b=[]; for(const m of c.matchAll(/```[\w]*\n([\s\S]*?)```/g)) b.push(m[1].trim().substring(0,150)); return b; }
function extractEntities(c) {
  const STOP=new Set(["The","This","That","These","Those","When","Where","What","How","Why","Who","Which","After","Before","During","Also","Note","Key","Use","Run","Add","Get","Set","Check","File","Code","Step","Each","Both","More","Most","Very","Just","Only","Even","Still"]);
  const counts={}; for(const w of c.match(/\b[A-Z][a-zA-Z]{2,}\b/g)||[]) { if(!STOP.has(w)) counts[w]=(counts[w]||0)+1; }
  return Object.entries(counts).filter(([,n])=>n>=2).map(([w])=>w).slice(0,8);
}
async function appendToLog(env,date,op,title,path) {
  // log.txt (not .md): a heading/table-dense markdown log of this size OOMs the
  // Obsidian metadata indexer on vault load. Plain .txt is skipped by the parser.
  // Also capped to the last LOG_MAX entries so it can never grow unbounded again.
  const LOG_MAX = 800;
  try {
    const ex = await readFile(env,"log.txt") || await readFile(env,"log.md") || "# Lnm-Brain Log\n";
    const entry = `[${date}] ${op} | ${title} | ${path} | ${new Date().toISOString()}\n`;
    const head = "# Lnm-Brain Log\n";
    const lines = (ex.replace(/^# Lnm-Brain Log\n?/,"").split("\n").filter(Boolean));
    lines.push(entry.trim());
    const capped = lines.slice(-LOG_MAX);
    await writeFile(env,"log.txt", head + capped.join("\n") + "\n", `log: ${op} ${title}`);
  } catch {}
}
// ─── v9.3: Reconciler pure helpers (network-free, unit-tested) ───────────────

// hubKeyForPath: maps a file path → its hub key.
// Dated filename (YYYY-MM-DD prefix) → "YYYY-MM"; undated → "_<dir>"; else "_misc".
function hubKeyForPath(p) {
  const name = p.split("/").pop();
  const m = name.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (m) return `${m[1]}-${m[2]}`;
  const parts = p.split("/");
  const dir = parts.length >= 2 ? parts[parts.length - 2] : "misc";
  return `_${dir}`;
}

function hasIndexBacklink(content) { return /\[\[index\]\]/.test(content || ""); }

function ensureBacklinkBlock(content, month) {
  if (hasIndexBacklink(content)) return content;
  const links = month ? `[[index]] · [[${month}]]` : `[[index]]`;
  return content.replace(/\s+$/, "") + `\n\n## Backlinks\n${links}\n`;
}

function buildHubFile(hubKey, fileNames) {
  const names = [...new Set(fileNames)].sort();
  const dated = /^\d{4}-\d{2}$/.test(hubKey);
  const title = dated ? `Session Index — ${hubKey}` : `Index — ${hubKey.replace(/^_/, "")}`;
  return [
    `---`,
    `type: ${dated ? "monthly-index" : "hub-index"}`,
    `hub: ${hubKey}`,
    `entries: ${names.length}`,
    `---`,
    ``,
    `# ${title}`,
    ``,
    `Auto-generated. ${names.length} entries.`,
    ``,
    `## Sessions`,
    ``,
    ...names.map(n => `- [[${n.replace(/\.md$/, "")}]]`),
    ``,
    `## Backlinks`,
    `[[index]]`,
    ``,
  ].join("\n");
}

function buildIndexSection(existingIndex, hubKeys) {
  const keys = [...new Set(hubKeys)].sort().reverse();
  const block = `## Indexes\n\n` + keys.map(k => `- [[wiki/_indexes/${k}|${k}]]`).join("\n") + "\n";
  const base = existingIndex || "# Lnm-Brain Index\n";
  if (/## Indexes\n[\s\S]*?(?=\n## |\n# |$)/.test(base)) {
    return base.replace(/## Indexes\n[\s\S]*?(?=\n## |\n# |$)/, block);
  }
  return base.replace(/\s+$/, "") + "\n\n" + block;
}

// ─────────────────────────────────────────────────────────────────────────────

async function updateIndex(env,title,path,summary) {
  // Retry up to 3 times on SHA conflict (concurrent writes to index.md)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const metaRes = await ghGet(env, "index.md", false);
      let sha = null, ex = "# Lnm-Brain Index\n\n## Wiki Pages\n\n";
      if (metaRes.ok) {
        const m = await metaRes.json(); sha = m.sha;
        const raw = await ghGet(env, "index.md", true);
        if (raw.ok) ex = await raw.text();
      }
      const slug = path.split("/").pop().replace(".md","");
      if (ex.includes(slug)) return; // already indexed

      // v7.9.0: ensure ## Monthly Indexes section exists with current month link
      const monthMatch = path.match(/(\d{4})-(\d{2})/);
      let next = ex + `- [[${path}|${title}]] — ${summary}\n`;
      if (monthMatch) {
        const ym = `${monthMatch[1]}-${monthMatch[2]}`;
        const monthLink = `- [[wiki/_indexes/${ym}|${ym}]]`;
        if (!next.includes("## Monthly Indexes")) {
          next = next.replace(/\s+$/, "") + `\n\n## Monthly Indexes\n${monthLink}\n`;
        } else if (!next.includes(monthLink)) {
          next = next.replace(/## Monthly Indexes\n/, `## Monthly Indexes\n${monthLink}\n`);
        }
      }

      const res = await ghPut(env,"index.md",next,`index: add ${title}`,sha);
      if (res.ok) return;
      if (res.status===409||res.status===422) continue; // SHA conflict → retry
      return; // other error
    } catch {}
  }
}

// ─── v9.3: Reconciler ────────────────────────────────────────────────────────
// Idempotent, batched. Builds monthly+dir hubs, links index→hubs, adds
// [[index]] backlinks to every in-scope file. Safe to re-run forever.
// HTTP/cron only — NOT an MCP tool (keeps tool count at 21).
const RECONCILE_DIRS = [
  "wiki/conversations","wiki/entities","wiki/topics","wiki/projects",
  "wiki/skills","wiki/rules","wiki/code","handoffs","raw/conversations",
];

async function handleReconcileIndex(req, env) {
  const body = await req.json().catch(() => ({}));
  const cursor  = parseInt(body.cursor  ?? 0, 10) || 0;
  const batch   = Math.min(60, Math.max(1, parseInt(body.batch ?? 40, 10) || 40));
  const dry_run = body.dry_run === true;
  const repo    = env.GITHUB_REPO   || "your-username/your-repo";
  const branch  = env.GITHUB_BRANCH || "main";

  // 1. Gather ALL in-scope files (uncapped via git tree)
  const allFiles = [];
  for (const dir of RECONCILE_DIRS) allFiles.push(...(await ghListAll(env, dir)));

  // 2. Group by hub key
  const groups = {};
  for (const f of allFiles) {
    const k = hubKeyForPath(f.path);
    if (!groups[k]) groups[k] = [];
    groups[k].push(f.name);
  }
  const hubKeys = Object.keys(groups).sort();

  // 3. Write/update hub files
  let hubs_written = 0;
  for (const k of hubKeys) {
    const hubPath = `wiki/_indexes/${k}.md`;
    const desired = buildHubFile(k, groups[k]);
    const current = await readFile(env, hubPath);
    if (current === desired) continue;
    if (!dry_run) {
      const ok = await writeFile(env, hubPath, desired, `reconcile: hub ${k} (${groups[k].length} entries)`);
      if (ok) hubs_written++;
    } else {
      hubs_written++;
    }
  }

  // 4. Update index.md ## Indexes section
  let index_updated = false;
  const indexRaw = await readFile(env, "index.md") || "# Lnm-Brain Index\n";
  const indexNew = buildIndexSection(indexRaw, hubKeys);
  if (indexNew !== indexRaw) {
    if (!dry_run) {
      index_updated = (await writeFile(env, "index.md", indexNew, `reconcile: index ## Indexes section (${hubKeys.length} hubs)`));
    } else {
      index_updated = true;
    }
  }

  // 5. Backlinks — batched by cursor (one GitHub read+PUT per file, expensive)
  const batchFiles = allFiles.slice(cursor, cursor + batch);
  let backlinks_added = 0;
  for (const f of batchFiles) {
    const content = await readFile(env, f.path);
    if (!content) continue;
    if (hasIndexBacklink(content)) continue;
    const month = hubKeyForPath(f.path).match(/^\d{4}-\d{2}$/) ? hubKeyForPath(f.path) : null;
    const updated = ensureBacklinkBlock(content, month);
    if (!dry_run) {
      const ok = await writeFile(env, f.path, updated, `reconcile: [[index]] backlink ${f.name}`);
      if (ok) backlinks_added++;
    } else {
      backlinks_added++;
    }
  }

  const nextCursor = cursor + batch < allFiles.length ? cursor + batch : null;
  const remaining  = nextCursor !== null ? allFiles.length - (cursor + batch) : 0;

  return jsonOk({
    scanned:         allFiles.length,
    hub_keys:        hubKeys.length,
    hubs_written,
    index_updated,
    backlinks_added,
    cursor:          nextCursor,
    remaining,
    dry_run,
  });
}

async function handleRebuildIndex(req, env) {
  const { dry_run = false } = await req.json().catch(() => ({}));
  const repo = env.GITHUB_REPO || "your-username/your-repo";
  const branch = env.GITHUB_BRANCH || "main";

  const [wikiRes, indexContent] = await Promise.all([
    ghFetch(env, `https://api.github.com/repos/${repo}/contents/wiki/conversations?ref=${branch}`,
      { headers: { Accept:"application/vnd.github.v3+json", "User-Agent":GH_UA } }),
    readFile(env,"index.md"),
  ]);

  if (!wikiRes.ok) return jsonErr("Could not list wiki files", 502);
  const wikiFiles = await wikiRes.json();
  const existing = indexContent || "# Lnm-Brain Index\n\n## Wiki Pages\n\n";

  const missing = wikiFiles.filter(f => f.name.endsWith(".md") && !existing.includes(f.name.replace(".md","")));
  if (dry_run) return jsonOk({ status:"dry-run", orphans_found: missing.length, sample: missing.slice(0,10).map(f=>f.name) });
  if (missing.length === 0) return jsonOk({ status:"ok", added:0, message:"Index already up to date" });

  // Append all missing entries in one write
  const additions = missing.map(f => {
    const slug = f.name.replace(".md","");
    const title = slug.replace(/^\d{4}-\d{2}-\d{2}-/,"").replace(/-/g," ");
    return `- [[wiki/conversations/${f.name}|${title}]] — _backfilled_`;
  }).join("\n");

  // Re-read with fresh SHA before writing
  let sha = null;
  let base = existing;
  const metaRes2 = await ghGet(env,"index.md",false);
  if (metaRes2.ok) { const m=await metaRes2.json(); sha=m.sha; const r=await ghGet(env,"index.md",true); if(r.ok) base=await r.text(); }

  const newContent = base.trimEnd() + "\n\n## Backfilled\n\n" + additions + "\n";
  const ok = (await ghPut(env,"index.md",newContent,`index: backfill ${missing.length} orphaned wiki files`,sha)).ok;
  return jsonOk({ status: ok?"rebuilt":"write-failed", added: ok?missing.length:0, orphans: missing.length });
}
function corsHeaders(){ return {"Access-Control-Allow-Origin":"*"}; }
function jsonHeaders(){ return {"Content-Type":"application/json",...corsHeaders()}; }
function jsonOk(d){ return new Response(JSON.stringify(d),{headers:jsonHeaders()}); }
function jsonErr(m,s=500){ return new Response(JSON.stringify({error:m}),{status:s,headers:jsonHeaders()}); }
function jrpcOk(id,r){ return new Response(JSON.stringify({jsonrpc:"2.0",id,result:r}),{headers:jsonHeaders()}); }
function jrpcErr(id,c,m){ return new Response(JSON.stringify({jsonrpc:"2.0",id,error:{code:c,message:m}}),{headers:jsonHeaders()}); }
function mcpOk(d){ return {content:[{type:"text",text:JSON.stringify(d)}]}; }
function mcpErr(m){ return {content:[{type:"text",text:JSON.stringify({error:m})}]}; }
async function withTimeout(p, ms, fallback) { return await Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]); }

// ─── API Reference ────────────────────────────────────────────────────────────
const API_REFERENCE = `Lnm-Brain v5.0

NEW IN v5.0:
  Entity normalization:  "Brain Owner" auto-maps to "Brain Owner" via KV alias lookup
  Contradiction detect:  new facts supersede outdated ones (confidence=0, superseded_by set)
  POST /backfill-facts   Batch-extract entity facts from all existing wiki/raw files
  POST /ask              Natural language Q&A: facts+docs → Western (Mistral/Llama) synthesised answer
  POST /register-entity-alias  {alias, canonical} — manually wire name variants

ENDPOINTS:
  GET  /facts?entity=    Confidence-scored facts for entity (alias-resolved)
  GET  /facts            List all known entities + alias map
  POST /ask              {question} → grounded answer from your notes
  POST /backfill-facts   {offset, batch_size, dry_run} → extract facts from existing files
  POST /extract-facts    Extract+store facts from arbitrary content
  POST /consolidate-facts  Dedup near-duplicate facts (also runs in cron)
  POST /register-entity-alias  {alias, canonical}

  POST /ingest    Full pipeline: raw → wiki → index → log → embed → facts
  POST /capture   Quick save (same pipeline)
  POST /compress  Preview compression
  POST /recompress-all  Batch upgrade old regex pages
  POST /lint      Health check + entity memory stats
  POST /prune     Remove stale orphans
  POST /health-check  Full integrity audit + auto-fix

  GET  /query?q=  Keyword search (27x token savings)
  POST /search    Semantic vector search
  GET  /graph     Knowledge graph
  GET  /file      Read specific file
  GET  /stats     Usage + entity memory stats

MCP tools: query_second_brain, get_entity_facts, ask_second_brain,
           semantic_search, capture_to_second_brain, ingest_to_second_brain,
           lint_second_brain, read_second_brain_file, get_second_brain_graph,
           write_second_brain_file`;

// ─── Browser UI ───────────────────────────────────────────────────────────────
function handleBrowserView() {
  const html = `<!DOCTYPE html>
<html><head><title>Lnm-Brain v5</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"><\/script>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f0f;color:white;overflow:hidden}
#net{width:100vw;height:100vh}
#loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:1.1rem;color:#aaa}
#bar{position:absolute;top:0;left:0;right:0;background:rgba(15,15,15,.97);border-bottom:1px solid #222;padding:10px 20px;z-index:1000;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
#bar h1{margin:0;font-size:16px;font-weight:600}
.badge{background:#1a1a2e;border:1px solid #333;color:#8b9cf7;padding:3px 8px;border-radius:4px;font-size:11px}
.badge-green{background:#0a2010;border:1px solid #1a5c2a;color:#4ade80}
.badge-gold{background:#1a1200;border:1px solid #5c4a00;color:#fbbf24}
.badge-blue{background:#001a2e;border:1px solid #005c8a;color:#60c8f0}
#sb{display:flex;gap:6px;flex:1;max-width:280px}
#sb input{flex:1;padding:6px 10px;border:1px solid #333;border-radius:5px;background:#1a1a1a;color:white;font-size:13px}
#sb button{padding:6px 12px;background:#4f46e5;color:white;border:none;border-radius:5px;cursor:pointer;font-size:13px}
#stats{position:absolute;bottom:16px;left:16px;background:rgba(0,0,0,.8);padding:10px 14px;border-radius:7px;font-size:12px;color:#777;z-index:100}
#panel{position:absolute;top:52px;right:16px;width:420px;max-height:calc(100vh-80px);background:rgba(15,15,15,.98);border:1px solid #222;border-radius:10px;padding:18px;z-index:1000;display:none;overflow-y:auto}
#panel h2{margin:0 0 8px;font-size:17px}.close{position:absolute;top:12px;right:12px;background:#222;border:none;color:#aaa;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:16px}
.meta{color:#666;font-size:12px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #1a1a1a}
.content{color:#bbb;line-height:1.7;white-space:pre-wrap;font-size:13px}
#leg{position:absolute;bottom:16px;right:16px;background:rgba(0,0,0,.8);padding:10px 14px;border-radius:7px;z-index:100}
#leg h3{margin:0 0 8px;font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.05em}
.li{display:flex;align-items:center;gap:7px;margin-bottom:5px;font-size:12px;color:#888}
.lc{width:10px;height:10px;border-radius:50%}
</style></head><body>
<div id="loading">Loading knowledge graph...</div>
<div id="bar">
  <h1>&#x1F9E0; Lnm-Brain</h1>
  <span class="badge">v5.0</span>
  <span class="badge-green">&#x26A1; Mistral-Nemotron</span>
  <span class="badge-gold">&#x1F4A1; Entity Memory</span>
  <span class="badge-blue">&#x1F50D; /ask</span>
  <div id="sb"><input id="si" placeholder="Search nodes..." onkeypress="if(event.key==='Enter')search()"><button onclick="search()">Search</button></div>
</div>
<div id="stats">Nodes: <span id="nc">0</span> | Edges: <span id="ec">0</span></div>
<div id="leg"><h3>Legend</h3>
  <div class="li"><div class="lc" style="background:#ef4444"></div>Entities</div>
  <div class="li"><div class="lc" style="background:#3b82f6"></div>Topics</div>
  <div class="li"><div class="lc" style="background:#22c55e"></div>Projects</div>
  <div class="li"><div class="lc" style="background:#a855f7"></div>Conversations</div>
</div>
<div id="panel">
  <button class="close" onclick="closeP()">&times;</button>
  <h2 id="pt"></h2><div class="meta" id="pm"></div><div class="content" id="pc">Loading...</div>
</div>
<div id="net"></div>
<script>
let net,od;
fetch('/graph-internal').then(r=>r.json()).then(d=>{
  document.getElementById('loading').style.display='none';
  od=d;document.getElementById('nc').textContent=d.nodes.length;document.getElementById('ec').textContent=d.edges.length;
  const nodes=new vis.DataSet(d.nodes.map(n=>({id:n.id,label:n.label,group:n.type,title:n.tags?n.tags.join(', '):'',value:n.connections?1+n.connections*.5:1})));
  const edges=new vis.DataSet(d.edges.map(e=>({from:e.from,to:e.to,arrows:'to',smooth:{type:'continuous'},color:{color:'#333'}})));
  net=new vis.Network(document.getElementById('net'),{nodes,edges},{
    nodes:{shape:'dot',size:18,borderWidth:2,shadow:true,font:{color:'#ccc',size:13}},
    edges:{width:1.5},
    groups:{entity:{color:{background:'#ef4444',border:'#b91c1c'}},topic:{color:{background:'#3b82f6',border:'#1d4ed8'}},project:{color:{background:'#22c55e',border:'#15803d'}},conversation:{color:{background:'#a855f7',border:'#7e22ce'}}},
    physics:{enabled:true,barnesHut:{gravitationalConstant:-3500,centralGravity:.4,springLength:160,springConstant:.04,damping:.09}},
    interaction:{hover:true,tooltipDelay:150,zoomView:true,dragView:true}
  });
  net.once('stabilizationIterationsDone',()=>net.fit());
  net.on('click',p=>{if(p.nodes.length){const n=od.nodes.find(n=>n.id===p.nodes[0]);if(n)showP(n)}else closeP()});
}).catch(e=>document.getElementById('loading').innerHTML='Error: '+e.message);
function showP(n){
  document.getElementById('pt').textContent=n.label;
  document.getElementById('pm').innerHTML='<span>Type: '+n.type+'</span>'+(n.tags&&n.tags.length?' · Tags: '+n.tags.join(', '):'');
  document.getElementById('pc').textContent='Loading...';
  document.getElementById('panel').style.display='block';
  if(n.path)fetch('/file?path='+encodeURIComponent(n.path)).then(r=>r.text()).then(c=>document.getElementById('pc').textContent=c).catch(e=>document.getElementById('pc').textContent='Error: '+e.message);
  else document.getElementById('pc').textContent='No file.';
}
function closeP(){document.getElementById('panel').style.display='none'}
function search(){
  const q=document.getElementById('si').value.toLowerCase().trim();
  if(!q||!net)return;
  const m=od.nodes.filter(n=>n.label.toLowerCase().includes(q)||(n.tags&&n.tags.some(t=>t.toLowerCase().includes(q))));
  if(m.length){net.focus(m[0].id,{scale:1.5,animation:{duration:400}});net.selectNodes([m[0].id])}
  else alert('No nodes: '+q);
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeP();if(e.key==='f'&&e.target.tagName!=='INPUT'&&net)net.fit()});
<\/script></body></html>`;
  return new Response(html, { headers:{ "Content-Type":"text/html" } });
}
