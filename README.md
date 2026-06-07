# homestead-mcp

Remote **MCP server** (Cloudflare Worker) that lets Claude maintain the
[`fuhrysteve/homestead`](https://github.com/fuhrysteve/homestead) repo — the
gardening / chickens / beekeeping knowledge base — as a **living wiki**, through a
**narrow, convention-enforcing tool surface** confined to the repo's `docs/` tree.

Built for MaryBeth's phone-only claude.ai (Pro) account via a **custom connector**:
as she brainstorms, troubleshoots, and plans on her phone, Claude reads and writes the
homestead wiki for her — no git, terminal, or laptop. Full spec, threat model, and
rationale live in the homelab repo: `docs/homestead-notes-mcp.md`.

## What it does

A constrained wiki editor over `docs/` — Read/Write/Edit mirror Claude Code; list/search
let Claude navigate; `log_event` keeps the dated-log convention. No generic file write,
no shell, no read outside `docs/`.

| Tool | Purpose |
|------|---------|
| `list_notes(subdir?)` | Browse the wiki tree (what pages exist). |
| `search_notes(query, subdir?)` | Find existing knowledge before writing (avoid duplicate pages). |
| `get_note(path)` | Read a page, e.g. `gardening/pests.md` (like Claude Code "Read"). |
| `edit_note(path, old_text, new_text, replace_all?)` | Surgical find/replace in a page (like "Edit"). |
| `write_note(path, content)` | Create or overwrite a whole page — any path under `docs/`, **new domains allowed** (like "Write"). |
| `log_event(domain, title, body?, date?)` | Prepend a `### <date> — <title>` entry to `docs/<domain>/log.md`. |
| `delete_note(path)` / `move_note(path, new_path)` | Housekeeping (revertible commits). |

All file paths are relative to `docs/` and must be `.md`. New top-level domains
(e.g. `orchard/…`) are created simply by writing a page there.

### Security model (two separate credentials)

- **Who may call it** — GitHub **OAuth** via [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
  The connector does OAuth 2.1 + PKCE against this Worker (the only auth claude.ai
  connectors support); the Worker bounces the human through GitHub login and only
  completes authorization for a login in `ALLOWED_GITHUB_LOGINS`.
- **What writes the commits** — a GitHub **App** scoped to *only* `fuhrysteve/homestead`,
  **Contents: read/write**. Its installation token is minted on demand from the App
  private key (WebCrypto RS256). Commits are **attributed to the authenticating GitHub
  user** (author + committer) — MB's saves show as MB, Steve's as Steve — using their
  GitHub `noreply` email when their address is private; falls back to the `homestead-bot`
  identity (`COMMIT_AUTHOR_*`) only if no user identity is available.
- **Path confinement** — every read/write is forced under `docs/` and must be `.md`;
  `..`, absolute paths, backslashes, and control chars are rejected server-side. Since
  everything is prefixed `docs/`, the sibling `reference/` binary tree is unreachable
  (see `src/paths.ts` + tests).
- **Blast radius** — worst case is "the one homestead repo," every change a revertible
  git commit. The Worker runs on Cloudflare's edge — **zero inbound exposure to the homelab.**

## Layout

```
src/
  index.ts           OAuthProvider wiring + the McpAgent (HomesteadMCP)
  github-handler.ts  GitHub OAuth upstream (login gate + allowlist)
  tools.ts           the 8 wiki tools (list/search/get/edit/write/log/delete/move)
  markdown.ts        log-insertion + find/replace edit transforms (pure, tested)
  paths.ts           docs/ path confinement (pure, tested)
  github.ts          GitHub App token + Contents/Trees API client
  env.ts             binding types
test/                vitest unit tests (paths, markdown, identity)
wrangler.jsonc       bindings + non-secret vars
```

## Develop

```bash
npm install
npm test          # vitest — path allowlist + markdown transforms
npm run typecheck # tsc --noEmit
npm run dev       # wrangler dev (needs .dev.vars — copy .dev.vars.example)
```

## Deploy (one-time setup)

**One GitHub App does both jobs** — it mints installation tokens (writes) *and*
provides the user-authorization (OAuth) flow that gates who may call the connector.
No separate OAuth App is needed.

### 1. Create the GitHub App

1. Your account → Settings → Developer settings → GitHub Apps → New.
   - **Permissions → Repository → Contents: Read and write.** Nothing else.
   - **Webhook → uncheck Active** (none needed).
   - Under **Identifying and authorizing users → Callback URL:**
     `https://homestead-mcp.fuhry.app/callback`
2. Generate a **private key** — GitHub gives you a PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`).
   WebCrypto needs **PKCS#8**, so convert:
   ```bash
   openssl pkcs8 -topk8 -nocrypt -in downloaded.pem -out homestead-app.pkcs8.pem
   ```
3. Generate a **client secret** (same page, "Client secrets" → Generate).
4. **Install** the App on *only* the `fuhrysteve/homestead` repo (Install App → Only
   select repositories → homestead).
5. Put the **App ID** and **Client ID** in `wrangler.jsonc` `vars` (`GITHUB_APP_ID`,
   `GITHUB_CLIENT_ID`). The **Installation ID is auto-resolved** from the repo at
   runtime — no need to configure it. Set `ALLOWED_GITHUB_LOGINS` to the login(s)
   permitted to authorize.

### 2. KV + secrets + deploy

```bash
# KV namespace backing the OAuth provider; paste the id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV

# Secrets (never committed)
npx wrangler secret put GITHUB_CLIENT_SECRET       # the GitHub App's client secret
npx wrangler secret put COOKIE_ENCRYPTION_KEY      # openssl rand -hex 32
npx wrangler secret put GITHUB_APP_PRIVATE_KEY     # paste the PKCS#8 PEM

npx wrangler deploy
```

### 3. Route + WAF

- Bind the Worker to **`homestead-mcp.fuhry.app`** (its own public DNS record — the
  `*.fuhry.app` wildcard otherwise resolves to a private IP).
- Add a Cloudflare **WAF rate-limit rule** on the route.

### 4. The connector (in MB's claude.ai account)

1. Settings → Connectors → add custom connector, URL **`https://homestead-mcp.fuhry.org/mcp`**
   (must include the `/mcp` path — the bare hostname authorizes but then 404s on MCP traffic).
2. Authorize once (GitHub login, allowlisted).
3. Set the writing tools — `write_note`, `edit_note`, `log_event`, `move_note` — to
   **Always allow**. Consider leaving `delete_note` on **Needs approval**. (Read tools
   `list_notes` / `search_notes` / `get_note` need no approval.)
4. Create the "Homestead" Project with the [project instructions](#project-instructions) below.

## Project instructions

Paste into MB's "Homestead" Claude Project. This is what turns the tools into an actively-
maintained wiki rather than a passive log:

> You help run our homestead and you maintain its knowledge base — a wiki of Markdown pages
> under `docs/` (domains: gardening, chickens, beekeeping, and new ones you create as needed).
> You can browse it (`list_notes`), search it (`search_notes`), read pages (`get_note`),
> create/rewrite pages (`write_note`), make surgical edits (`edit_note`), record dated events
> (`log_event`), and tidy up (`move_note` / `delete_note`).
>
> **Ground every substantive answer in the wiki.** Before answering a how-to, planning, or
> troubleshooting question, `search_notes` (and read the relevant page) so you build on what we
> already know and our actual setup, not generic advice.
>
> **Capture durable knowledge as we go, without being asked.** When a conversation produces a
> decision, a plan, a how-to, a diagnosis, or a changed fact, write it into the right topic page:
> `edit_note` for a small change to an existing page, `write_note` to create a new page or section.
> Keep edits surgical and read the page first. Put lasting context in domain `README.md`/topic
> pages; put things that *happened on a date* (a planting, an inspection, a pest sighting, a repair)
> in `log_event`. If a topic doesn't fit an existing page, create one (e.g. `gardening/pests.md`);
> if it doesn't fit an existing domain, create a new domain.
>
> **Troubleshooting (e.g. a photo of leaf/pest damage):** identify it and give treatment advice,
> then capture the finding — what it was, how you identified it, what to do — on the relevant topic
> page (e.g. `gardening/pests.md`) and, if it happened on a date, a `log_event` too. (You can't save
> the photo itself; capture the knowledge.)
>
> Follow repo conventions: newest-first ISO-dated log entries; advice suited to NE Ohio / Zone 6a.
> After you save, confirm in one line what you wrote and where. When unsure whether something is
> worth keeping, save it — a brief note beats losing it.

## License

Private homelab project.
