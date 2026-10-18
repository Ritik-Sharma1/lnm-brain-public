# Install LNM Brain

LNM Brain is a memory for your AI tools that you host yourself. It runs on your own
Cloudflare account, keeps every note in your own private GitHub repo, and plugs into
Claude Code, the Claude app (web, desktop, phone) and any other MCP client.

**Time:** about TIME_TBD minutes the first time. **Cost:** Cloudflare Workers Paid, $5/month, is
recommended ([why](#cost-free-vs-paid)). **Skill level:** you can copy commands into a terminal.

> [!IMPORTANT]
> Your **API key is a password** for everything you ever saved. Anyone who has it can read
> and change your memory. Keep it in a password manager, never paste it into a chat, a
> screenshot, a screen recording or a public file. If it leaks, [rotate it](#rotate-your-api-key).

---

## The easy way: let Claude Code install it

If you have [Claude Code](https://claude.com/claude-code), paste this into it:

```text
Install LNM Brain for me from https://github.com/Ritik-Sharma1/lnm-brain-public.
Clone it, read INSTALL.md, and follow it step by step.
Before each step that creates something or could cost money (the GitHub repo,
Cloudflare resources, the Workers Paid plan), tell me what it will do and wait for my OK.
Never print my API key or my GitHub token in this chat: generate the API key straight
into ~/.config/lnm-brain/api-key as the guide says, and when the GitHub token step comes,
give me the exact command to run in my own terminal and wait until I say done.
When you finish, run the checks in Step 8, connect this Claude Code to my brain, and tell me
exactly what to enter in the Claude app's "Add custom connector" dialog.
```

Claude Code will still ask you to do three things yourself: log in to Cloudflare in your
browser, create the GitHub token, and paste that token into your terminal.

The rest of this page is the same install done by hand.

---

## Before you start

You need:

| What | Why | Check |
|---|---|---|
| A GitHub account | Your notes live in a private repo you own | [github.com](https://github.com) |
| A Cloudflare account | Runs the brain (Workers, KV, D1, Vectorize, Workers AI) | [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) |
| Node.js 20 or newer | Runs `wrangler`, Cloudflare's command-line tool | `node --version` |
| git | Downloads this repo | `git --version` |
| Claude Code (optional) | The one-prompt install and the auto-memory hooks | `claude --version` |
| `jq`, `curl`, `python3` | Only for the auto-memory hooks (Step 11) | macOS: `brew install jq` |

Commands below are for macOS or Linux. On Windows, use WSL.

---

## Cost: Free vs Paid

**Recommended: Workers Paid, $5/month.** For one person it normally stays inside the
included usage, so the bill is the flat $5. Upgrade in the Cloudflare dashboard:
**Workers & Pages → Plans → Workers Paid**.

The Free plan can run a small brain, but you will hit its limits as the brain grows.
What LNM Brain used per action in our measurements (a fresh brain, no extra AI keys):

| Free plan limit | What LNM Brain uses | What it means on Free |
|---|---|---|
| 10 ms CPU per request and per cron run | 1–4 ms per save or search (measured locally) | OK while the brain is small; heavy maintenance jobs can fail with error 1102 |
| 50 outside requests per request | ~10 GitHub calls per save, up to ~22 in the 6-hourly maintenance run | OK at first; maintenance grows with the number of notes |
| KV: 1,000 writes per day | ~12 per save, plus ~96 per day from the 15-minute health check | about 70 saves per day |
| Vectorize: 5 million stored dimensions | ~7.5 vectors × 1024 dimensions per save | full after about 650 saves |
| Workers AI: 10,000 neurons per day | summaries and embeddings when you add no AI key | roughly 50 saves per day |

The Free plan has **not** been tested end to end on a real Free account. If you try it and
see `Worker exceeded resource limits` (error 1102) or a KV/D1/Vectorize "limit exceeded"
error, upgrade to Paid; nothing needs reinstalling.

Optional AI keys (Step 12) improve the summaries. The only one that can cost extra money is
an OpenRouter key: it is used as a paid last resort when every free option fails.

---

## Step 1. Get the code

```bash
git clone https://github.com/Ritik-Sharma1/lnm-brain-public.git
cd lnm-brain-public/worker
npm install
```

All `npx wrangler …` commands below are run from this `worker` folder.

## Step 2. Log in to Cloudflare

```bash
npx wrangler login
npx wrangler whoami
```

`login` opens your browser; click **Allow**. `whoami` should print your account.
If `whoami` says the token is read from the `CLOUDFLARE_API_TOKEN` environment variable, an
older token from another project is overriding your login and may lack D1 or Vectorize
access. Run `unset CLOUDFLARE_API_TOKEN` in this terminal, then `npx wrangler login` again.
If it lists more than one account, copy the right **Account ID** and add this line near
the top of `worker/wrangler.toml`:

```toml
account_id = "<your-account-id>"
```

## Step 3. Create your private memory repo on GitHub

1. Open [github.com/new](https://github.com/new).
2. Repository name: `my-brain-data` (any name works).
3. Choose **Private**. Tick **Add a README file** (the repo must not be empty).
4. Click **Create repository**.

Or with the GitHub CLI: `gh repo create my-brain-data --private --add-readme`

Now open `worker/wrangler.toml` and set your repo (owner/name):

```toml
[vars]
GITHUB_REPO = "<your-github-username>/my-brain-data"
GITHUB_BRANCH = "main"
```

## Step 4. Create a GitHub token for that one repo

1. Open [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
   (Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token).
2. **Token name:** `lnm-brain`. **Expiration:** your choice (put a reminder in your calendar).
3. **Repository access:** **Only select repositories** → pick `my-brain-data`.
4. **Permissions → Repository permissions → Contents → Read and write.**
   (GitHub adds *Metadata: Read-only* by itself. Nothing else is needed.)
5. Click **Generate token** and copy it. GitHub shows it only once.

Keep it on your clipboard for Step 7. Do not paste it anywhere else.

## Step 5. Create the Cloudflare storage

Run these three commands. If wrangler asks *"Would you like Wrangler to add it on your
behalf?"*, answer **No**: the config already has a slot for each one.

```bash
npx wrangler kv namespace create VECTORS
npx wrangler d1 create lnm-brain-fts
npx wrangler vectorize create lnm-brain-m3 --dimensions=1024 --metric=cosine
```

Copy two values into `worker/wrangler.toml`:

- the KV `id` printed by the first command → replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`
- the D1 `database_id` printed by the second → replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`

The Vectorize index needs no id, but it must be **1024 dimensions, cosine**; that can't be
changed later. Then create the D1 tables used by projects and the Hermes endpoints:

```bash
npx wrangler d1 execute lnm-brain-fts --remote --file=../migrations/003_hermes.sql -y
npx wrangler d1 execute lnm-brain-fts --remote --file=../migrations/004_projects.sql -y
```

## Step 6. Deploy

```bash
npx wrangler deploy
```

New Cloudflare accounts are asked to pick a `workers.dev` subdomain once; any name works.
The output ends with your worker URL:

```text
https://my-lnm-brain.<your-subdomain>.workers.dev
```

Save it; the rest of this guide calls it `<worker-url>`. Right now the brain is locked: every
memory route answers `503 API_KEY not configured` until Step 7. That is on purpose.

## Step 7. Set the secrets

Generate a random API key straight into a private file (it is never printed), then give it
to the worker:

```bash
mkdir -p ~/.config/lnm-brain && chmod 700 ~/.config/lnm-brain
openssl rand -hex 32 | tr -d '\n' > ~/.config/lnm-brain/api-key && chmod 600 ~/.config/lnm-brain/api-key
npx wrangler secret put API_KEY < ~/.config/lnm-brain/api-key
```

Now the GitHub token. Run this yourself and paste the token from Step 4 when it asks:

```bash
npx wrangler secret put GITHUB_TOKEN
```

Also save the API key in your password manager. To copy it on a Mac:
`pbcopy < ~/.config/lnm-brain/api-key`.

## Step 8. Check that it works

Replace `<worker-url>` with yours:

```bash
URL="<worker-url>"
curl -s "$URL/health" | python3 -m json.tool | head -8
curl -s -H "X-API-Key: $(cat ~/.config/lnm-brain/api-key)" "$URL/health?deep=1" | python3 -m json.tool | grep -A3 github_ping
curl -s -o /dev/null -w "%{http_code}\n" "$URL/api/home-feed"
```

You should see:

1. `"status": "ok"`, `"version": "10.2.3"` and `"auth": "configured"`.
2. `"ok": true, "status": 200` under `github_ping` (your token can reach the repo).
3. `401` for the last line: without the key, nobody gets in.

Then save a first memory and read it back:

```bash
KEY="$(cat ~/.config/lnm-brain/api-key)"
curl -s -X POST "$URL/capture" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"type":"note","title":"first-memory","content":"My second brain is live. I prefer short answers.","surface":"other"}'
curl -s -G "$URL/recall" -H "X-API-Key: $KEY" --data-urlencode "q=second brain live" | head -c 400; echo
```

A minute later the note also appears as a file under `raw/` in your GitHub repo.

## Step 9. Connect Claude Code

```bash
claude mcp add --transport http --scope user lnm-brain "<worker-url>/mcp" \
  --header "X-API-Key: $(cat ~/.config/lnm-brain/api-key)"
claude mcp list
```

`claude mcp list` should show `lnm-brain … ✓ Connected`. In a Claude Code chat, `/mcp`
lists its 27 tools. `--scope user` makes it available in every project.

## Step 10. Connect the Claude app (web, desktop and phone)

Add it once on [claude.ai](https://claude.ai) in a browser or in Claude Desktop. It then
works in the phone app too, because connectors belong to your account.

1. Open [**Customize → Connectors**](https://claude.ai/customize/connectors).
2. Click **+ Add** → **Add custom connector**. Name it `LNM Brain`.
3. **URL:** `<worker-url>/mcp` → **Continue**.
4. **Authentication:** choose **No sign-in**.
5. **Request headers:** pick `x-api-key`, paste your API key as the value, mark it **Required**.
6. Click **Add**.

If your dialog has **no Request headers section** (it is still a beta that not every account
has), use this URL in step 3 instead and skip step 5:

```text
<worker-url>/mcp?key=<your-API-key>
```

> [!WARNING]
> With `?key=` the **connector URL itself is a password**. Don't share it, screenshot it, or
> paste it into chats or documents. If it leaks, [rotate the key](#rotate-your-api-key).

To use it in a chat, click **+** → **Connectors** and switch **LNM Brain** on (on the phone:
**+** → **Connectors**). The Free Claude plan allows one custom connector.

## Step 11. Turn on auto-memory in Claude Code (optional)

These hooks make every Claude Code session load your latest context, pull memories that match
each prompt, and save a summary of the session for you.

```bash
cd ..   # back to the repo root
BRAIN_BASE_URL="<worker-url>" BRAIN_API_KEY="$(cat ~/.config/lnm-brain/api-key)" \
  bash scripts/setup-global-hooks.sh
```

The script checks your key against the worker, writes `~/.config/lnm-brain/config`
(readable only by you), copies the hooks to `~/.config/lnm-brain/hooks/`, backs up
`~/.claude/settings.json`, and adds four hooks to it. Restart Claude Code afterwards.

- Saves are throttled to one per 6 of your messages, plus one when the session ends
  (change with `LNM_CAPTURE_EVERY`), so they don't burn your Free-plan quota.
- Problems are logged to `~/.cache/lnm-brain/capture.log`.
- To turn it off, delete the four `lnm-brain` hook entries from `~/.claude/settings.json`.

## Step 12. Better AI models (optional)

With no extra keys, summaries and fact extraction use Cloudflare Workers AI
(`llama-3.1-8b`, free daily allowance). It works but is the weakest option. To improve it,
add a free NVIDIA key:

1. Get a key at [build.nvidia.com](https://build.nvidia.com) (sign in → any model → **Get API Key**).
2. Store it under these two names (the names are historical; both hold the same NVIDIA key):

```bash
npx wrangler secret put MISTRAL_NEMOTRON_API_Key
npx wrangler secret put MISTRAL_LARGE_API_Key
```

---

## All secrets

Set with `npx wrangler secret put <NAME>`. Never put them in `wrangler.toml` or any file in git.

| Secret | Needed? | What it does | Without it |
|---|---|---|---|
| `API_KEY` | **Required** | The password for every memory route, `/mcp` included. 16+ random characters. | Everything answers `503` (locked) |
| `GITHUB_TOKEN` | **Required** (or the GitHub App trio below) | Writes and reads notes in your private repo | Notes are not saved to GitHub; recall loses the full text |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID` | Optional | Use a GitHub App instead of a personal token (higher rate limit) | `GITHUB_TOKEN` is used |
| `ADMIN_KEY` | Optional | Unlocks `/admin/*` maintenance routes (sent as `x-admin-key`) | Those routes answer `403` |
| `MISTRAL_NEMOTRON_API_Key`, `MISTRAL_LARGE_API_Key`, `DRACARYS_API_Key`, `DEEPSEEK_API_Key`, `STEP_API_Key` | Optional, free | NVIDIA NIM keys (the names are historical) for summaries, fact extraction and answers | Workers AI `llama-3.1-8b` |
| `OPENCODE_ZEN_API_KEY` | Optional, free models | OpenCode Zen free models, second choice after NVIDIA | Skipped |
| `VERCEL_AI_GATEWAY_KEY` | Optional, **paid** | Vercel AI Gateway; the worker stops using it at about $4.50 a month | Skipped |
| `OPENROUTER_API_KEY` | Optional, **can cost money** | OpenRouter free models, and paid models as the very last resort | Skipped |
| `TELEGRAM_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_CHAT_ID` | Optional | Save notes by messaging your own Telegram bot ([setup](#telegram-capture-optional)) | `/telegram` is off |

Plain settings (not secrets) live in `wrangler.toml` under `[vars]`: `GITHUB_REPO`, `GITHUB_BRANCH`.

---

## Telegram capture (optional)

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Set three secrets: `TELEGRAM_TOKEN` (the bot token), `TELEGRAM_WEBHOOK_SECRET`
   (run `openssl rand -hex 32`), and `TELEGRAM_CHAT_ID` (leave it for step 4 if you don't know it).
3. Point Telegram at your worker, using the same webhook secret:

   ```bash
   curl -s "https://api.telegram.org/bot<bot-token>/setWebhook" \
     --data-urlencode "url=<worker-url>/telegram" \
     --data-urlencode "secret_token=<webhook-secret>"
   ```

4. Message your bot. If `TELEGRAM_CHAT_ID` isn't set yet, the bot replies with your chat id;
   set it as the `TELEGRAM_CHAT_ID` secret. Only that chat can save notes. Bots are public,
   so anyone else who messages it is ignored.

## Rotate your API key

```bash
openssl rand -hex 32 | tr -d '\n' > ~/.config/lnm-brain/api-key
npx wrangler secret put API_KEY < ~/.config/lnm-brain/api-key
```

The old key stops working within seconds. Then update every place that used it: run
`claude mcp remove lnm-brain --scope user` and Step 9 again, remove and re-add the Claude app
connector (Step 10), and re-run Step 11 with the new key.

## Troubleshooting

| You see | Fix |
|---|---|
| `503 … API_KEY not configured` | Step 7 isn't done, or the key is shorter than 16 characters or a placeholder like `YOUR_API_KEY`. |
| `401 Invalid API key` / `API key required` | The key you sent doesn't match. Check the `X-API-Key` header or the `?key=` part of the URL. |
| `wrangler deploy` fails with `ETIMEDOUT` | Some networks block Node from reaching api.cloudflare.com. Try another network, or deploy with curl: set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then run `node scripts/deploy-via-curl.js`. |
| `Authentication error [code: 10000]` while creating D1 or Vectorize | A `CLOUDFLARE_API_TOKEN` in your shell overrides `wrangler login` and lacks those permissions. Run `unset CLOUDFLARE_API_TOKEN`, then `npx wrangler login` (Step 2). |
| `REPLACE_WITH_YOUR_…` / binding errors on deploy | Paste the KV `id` and D1 `database_id` from Step 5 into `wrangler.toml`. |
| `github_ping` shows `401` or `404` in Step 8 | Wrong `GITHUB_REPO`, or the token lacks **Contents: Read and write** on that repo. Fix and run `npx wrangler secret put GITHUB_TOKEN` again. |
| Vectorize `dimension mismatch` errors | The index wasn't created with `--dimensions=1024 --metric=cosine`. Run `npx wrangler vectorize delete lnm-brain-m3`, create it again, then redeploy. |
| `Worker exceeded resource limits` (1102), or KV/D1/Vectorize "limit exceeded" | You hit a Free-plan limit. Upgrade to Workers Paid. |
| Claude app connector won't connect | The URL must end in `/mcp` (plus `?key=…` if you didn't use a request header). Test it: `curl -s -X POST "<worker-url>/mcp" -H "X-API-Key: <key>" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \| head -c 200` |
| Hooks do nothing | Restart Claude Code. Check `~/.cache/lnm-brain/capture.log`, and run `bash ~/.config/lnm-brain/hooks/session_start_second_brain.sh` to see its output. |
| More than one Cloudflare account | Add `account_id = "<id>"` to `wrangler.toml` (Step 2). |

## Uninstall

```bash
npx wrangler delete                         # the worker
npx wrangler kv namespace delete --binding VECTORS
npx wrangler d1 delete lnm-brain-fts
npx wrangler vectorize delete lnm-brain-m3
claude mcp remove lnm-brain --scope user
```

Then remove the connector in the Claude app, delete the `lnm-brain` hook entries from
`~/.claude/settings.json`, delete `~/.config/lnm-brain`, and revoke the GitHub token. Your
notes stay in your GitHub repo until you delete it.
